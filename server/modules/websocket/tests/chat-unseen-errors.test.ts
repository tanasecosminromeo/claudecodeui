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
 * After a server restart a reattached session streams before any browser is
 * back. What Claude writes is in its transcript and the browser reloads it;
 * an error the app itself raised — "that step was stopped because of the
 * restart" — is not, so it is kept until someone subscribes. And a browser's
 * last seen event number belongs to the previous server: it must not hide the
 * new run's events.
 */

const SESSION_ID = 'unseen-errors-session';

function createFakeSocket() {
  const socket = new EventEmitter() as EventEmitter & { readyState: number; frames: Array<Record<string, unknown>>; send: (data: string) => void };
  socket.readyState = 1;
  socket.frames = [];
  socket.send = (data: string) => socket.frames.push(JSON.parse(data) as Record<string, unknown>);
  return socket;
}

async function withGateway(runTest: (connect: () => ReturnType<typeof createFakeSocket>) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-unseen-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();
  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Unseen', now, now, null);
    const runtime = { hasRuntime: () => true, hasBackgroundWork: () => false, getPendingApprovalsForSession: () => [] };
    await runTest(() => {
      const socket = createFakeSocket();
      handleChatConnection(socket as never, { user: { id: 1 } } as never, { runtime: runtime as never });
      return socket;
    });
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
const subscribe = (socket: ReturnType<typeof createFakeSocket>, lastSeq: number) =>
  socket.emit('message', JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: SESSION_ID, lastSeq }] }));

/** A run as a reattach opens it: nobody watching. */
function startUnwatchedRun() {
  const run = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: 'native', connection: null, userId: null });
  assert.ok(run);
  return run;
}

test('an error raised while nobody watched is shown to the first browser that subscribes, once', async () => {
  await withGateway(async (connect) => {
    const run = startUnwatchedRun();
    run.writer.send({ kind: 'error', content: 'that step was stopped', sessionId: 'native', provider: 'claude' });
    run.writer.send({ kind: 'complete', sessionId: 'native', provider: 'claude', exitCode: 0 });

    // The browser comes back with an event number from before the restart.
    const first = connect();
    subscribe(first, 812);
    await settle();
    const errors = first.frames.filter((frame) => frame.kind === 'error');
    assert.deepEqual(errors.map((frame) => frame.content), ['that step was stopped']);

    const second = connect();
    subscribe(second, 0);
    await settle();
    assert.deepEqual(second.frames.filter((frame) => frame.kind === 'error'), [], 'shown once, not on every subscribe');
  });
});

test('a browser whose last event number predates the run replays the running run from its start', async () => {
  await withGateway(async (connect) => {
    const run = startUnwatchedRun();
    run.writer.send({ kind: 'text', content: 'streamed during the restart', sessionId: 'native', provider: 'claude' });

    const socket = connect();
    subscribe(socket, 812);
    await settle();
    assert.deepEqual(socket.frames.filter((frame) => frame.kind === 'text').map((frame) => frame.content), ['streamed during the restart']);
  });
});

test('an error seen live is not shown again on subscribe', async () => {
  await withGateway(async (connect) => {
    const watcher = connect();
    const run = chatRunRegistry.startRun({ appSessionId: SESSION_ID, provider: 'claude', providerSessionId: 'native', connection: watcher as never, userId: null });
    run?.writer.send({ kind: 'error', content: 'seen live', sessionId: 'native', provider: 'claude' });
    run?.writer.send({ kind: 'complete', sessionId: 'native', provider: 'claude', exitCode: 0 });

    const later = connect();
    subscribe(later, 0);
    await settle();
    assert.deepEqual(later.frames.filter((frame) => frame.kind === 'error'), []);
  });
});
