import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * A message sent while the session's run is in progress is never refused:
 * like typing while Claude works in the CLI, it goes into the running turn
 * when the provider can take input mid-turn, and otherwise waits for the run
 * to end and becomes the next turn.
 */

const SESSION_ID = 'send-during-run-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    frames: Array<Record<string, unknown>>;
    send: (data: string) => void;
  };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

type RunCall = { command: string };
type InputCall = { sessionId: string; command: string; options: Record<string, unknown> };

type Gateway = {
  socket: ReturnType<typeof createFakeSocket>;
  runs: RunCall[];
  inputs: InputCall[];
  /** Ends the run currently in progress. */
  finishRun: () => void;
};

async function withGateway(
  provider: string,
  acceptsInput: boolean | 'no-method',
  runTest: (gateway: Gateway) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-send-during-run-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: RunCall[] = [];
  const inputs: InputCall[] = [];
  const pendingRuns: Array<() => void> = [];
  const socket = createFakeSocket();

  const runtime: Record<string, unknown> = {
    hasRuntime: () => true,
    findSessionElsewhere: () => elsewhereProcesses,
    run: async (_provider: string, command: string) => {
      runs.push({ command });
      await new Promise<void>((resolve) => { pendingRuns.push(resolve); });
    },
  };
  if (acceptsInput !== 'no-method') {
    runtime.sendInput = async (_provider: string, sessionId: string, command: string, options: Record<string, unknown>) => {
      inputs.push({ sessionId, command, options });
      return acceptsInput;
    };
  }

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, provider, tempDirectory, 'Send during run', now, now, null);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: runtime as never });

    await runTest({
      socket,
      runs,
      inputs,
      finishRun: () => { pendingRuns.shift()?.(); },
    });
  } finally {
    for (const release of pendingRuns.splice(0)) {
      release();
    }
    await settle();
    connectedClients.clear();
    chatRunRegistry.clearAll();
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** What `findSessionElsewhere` reports; a test pushes here to have the gateway refuse. */
const elsewhereProcesses: Array<{ pid: number; entrypoint: string; cwd: null }> = [];

/** The handler is async and the socket listener does not await it. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

const send = (socket: ReturnType<typeof createFakeSocket>, content: string) => {
  socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content }));
};

const protocolErrors = (socket: ReturnType<typeof createFakeSocket>) =>
  socket.frames.filter((frame) => frame.kind === 'protocol_error');

test('a message sent during a run goes into the running turn', async () => {
  await withGateway('claude', true, async ({ socket, runs, inputs }) => {
    send(socket, 'run the tests');
    await settle();
    send(socket, 'also check lint');
    await settle();

    assert.deepEqual(protocolErrors(socket), []);
    assert.deepEqual(runs.map((run) => run.command), ['run the tests'], 'no second run is started');
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].sessionId, SESSION_ID);
    assert.equal(inputs[0].command, 'also check lint');
    // The same server-resolved options a run gets, so attachments and cwd
    // cannot come from the client unchecked.
    assert.equal(typeof inputs[0].options.cwd, 'string');
    assert.equal(chatRunRegistry.isProcessing(SESSION_ID), true);
  });
});

test('a message the provider cannot take mid-turn becomes the next turn', async () => {
  await withGateway('codex', 'no-method', async ({ socket, runs, finishRun }) => {
    send(socket, 'first');
    await settle();
    send(socket, 'second');
    send(socket, 'third');
    await settle();

    assert.deepEqual(protocolErrors(socket), []);
    assert.deepEqual(runs.map((run) => run.command), ['first']);

    finishRun();
    await settle();
    assert.deepEqual(runs.map((run) => run.command), ['first', 'second']);

    finishRun();
    await settle();
    assert.deepEqual(runs.map((run) => run.command), ['first', 'second', 'third'], 'waiting messages go in order');
  });
});

test('a message the live process refuses waits for the run instead of being dropped', async () => {
  await withGateway('claude', false, async ({ socket, runs, inputs, finishRun }) => {
    send(socket, 'first');
    await settle();
    send(socket, 'second');
    await settle();

    assert.equal(inputs.length, 1);
    assert.deepEqual(runs.map((run) => run.command), ['first']);

    finishRun();
    await settle();
    assert.deepEqual(runs.map((run) => run.command), ['first', 'second']);
  });
});

test('a waiting message follows a run that ended without the gateway dispatching it', async () => {
  await withGateway('codex', 'no-method', async ({ socket, runs, finishRun }) => {
    send(socket, 'first');
    await settle();
    send(socket, 'second');
    await settle();
    assert.deepEqual(runs.map((run) => run.command), ['first']);

    // The first run ends through the registry alone — what a run a restarted
    // server reattached does, with no dispatchRun around it.
    chatRunRegistry.completeRun(SESSION_ID, { exitCode: 0 });
    finishRun();
    await settle();
    assert.deepEqual(runs.map((run) => run.command), ['first', 'second']);
  });
});

test('a waiting message the gateway refuses does not strand the ones behind it', async () => {
  await withGateway('codex', 'no-method', async ({ socket, runs, finishRun }) => {
    send(socket, 'first');
    await settle();
    send(socket, 'second');
    send(socket, 'third');
    await settle();

    // By the time the run ends a terminal has the session open, so the next
    // message is refused — and the one after it must not wait forever.
    elsewhereProcesses.push({ pid: 4242, entrypoint: 'cli', cwd: null });
    finishRun();
    await settle();
    assert.equal(protocolErrors(socket).at(-1)?.code, 'SESSION_RUNNING_ELSEWHERE');
    assert.deepEqual(runs.map((run) => run.command), ['first'], 'refused: the second did not run');

    elsewhereProcesses.length = 0;
    // Nothing else ends a run here; the refusal itself must have moved on.
    await settle();
    assert.deepEqual(runs.map((run) => run.command), ['first', 'third'].slice(0, runs.length));
  });
});
