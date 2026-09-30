import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { handleChatConnection, runDetachedChatTurn } from '@/modules/websocket/services/chat-websocket.service.js';
import { chatRunRegistry } from '@/modules/websocket/services/chat-run-registry.service.js';
import { connectedClients } from '@/modules/websocket/services/websocket-state.service.js';

/**
 * A session open in another Claude process — a terminal `claude --resume` —
 * is never silently joined by a second process here. The sender is told where
 * it runs and can choose to take it over; a scheduled message never does.
 */

const SESSION_ID = 'elsewhere-session';
const TERMINAL = { pid: 4242, entrypoint: 'cli', cwd: '/work' };

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; frames: Array<Record<string, unknown>>; send: (data: string) => void };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

async function withGateway(
  runTest: (gateway: { socket: ReturnType<typeof createFakeSocket>; runs: string[]; takeOvers: string[]; runtime: Record<string, unknown> }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-elsewhere-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const runs: string[] = [];
  const takeOvers: string[] = [];
  let elsewhere = [TERMINAL];
  const socket = createFakeSocket();
  const runtime = {
    hasRuntime: () => true,
    run: async (_provider: string, command: string) => { runs.push(command); },
    findSessionElsewhere: () => elsewhere,
    takeOverSession: async (_provider: string, sessionId: string) => { takeOvers.push(sessionId); elsewhere = []; return true; },
  };

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Elsewhere', now, now, null);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: runtime as never });
    await runTest({ socket, runs, takeOvers, runtime });
  } finally {
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

const settle = () => new Promise((resolve) => { setTimeout(resolve, 30); });

test('a session open in a terminal is not joined by a second process', async () => {
  await withGateway(async ({ socket, runs }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'hello', options: { model: 'sonnet' } }));
    await settle();

    assert.deepEqual(runs, []);
    const refusal = socket.frames.find((frame) => frame.code === 'SESSION_RUNNING_ELSEWHERE');
    assert.ok(refusal, 'the sender is told why');
    assert.deepEqual(refusal?.processes, [TERMINAL]);
    // Echoed so the client can resend it as a take-over without keeping a copy.
    assert.deepEqual(refusal?.retry, { content: 'hello', options: { model: 'sonnet' } });
  });
});

test('taking the session over stops the terminal process and runs the message', async () => {
  await withGateway(async ({ socket, runs, takeOvers }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.send', sessionId: SESSION_ID, content: 'hello', options: { takeOver: true } }));
    await settle();

    assert.deepEqual(takeOvers, [SESSION_ID]);
    assert.deepEqual(runs, ['hello']);
  });
});

test('a scheduled message never takes a session over on its own', async () => {
  await withGateway(async ({ runs, takeOvers, runtime }) => {
    const outcome = await runDetachedChatTurn(
      { sessionId: SESSION_ID, userId: 1, content: 'nightly', options: { takeOver: true } },
      { runtime: runtime as never },
    );

    assert.equal(outcome.started, false);
    assert.match(String(outcome.error), /terminal/);
    assert.deepEqual(takeOvers, []);
    assert.deepEqual(runs, []);
  });
});
