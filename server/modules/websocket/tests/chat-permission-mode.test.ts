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
 * The composer's permission mode reaches a session that is already running:
 * picking a mode mid-run switches the live process, and approving a plan says
 * which mode to continue in.
 */

const SESSION_ID = 'permission-mode-session';

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

async function withGateway(
  runTest: (gateway: {
    socket: ReturnType<typeof createFakeSocket>;
    modes: unknown[][];
    decisions: unknown[][];
  }) => Promise<void>,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'chat-permission-mode-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  const modes: unknown[][] = [];
  const decisions: unknown[][] = [];
  const socket = createFakeSocket();

  try {
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempDirectory, 'Permission mode', now, now, null);
    handleChatConnection(socket as never, { user: { id: 1 } } as never, {
      runtime: {
        hasRuntime: () => true,
        setPermissionMode: async (provider: string, sessionId: string, mode: string) => {
          modes.push([provider, sessionId, mode]);
          return true;
        },
        resolveToolApproval: (requestId: string, decision: unknown) => {
          decisions.push([requestId, decision]);
        },
      } as never,
    });
    await runTest({ socket, modes, decisions });
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

test('a mode picked in the composer is applied to the session\'s live process', async () => {
  await withGateway(async ({ socket, modes }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.set-permission-mode', sessionId: SESSION_ID, permissionMode: 'auto' }));
    await settle();

    assert.deepEqual(modes, [['claude', SESSION_ID, 'auto']]);
    assert.deepEqual(socket.frames, []);
  });
});

test('a mode change without a mode is refused', async () => {
  await withGateway(async ({ socket, modes }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.set-permission-mode', sessionId: SESSION_ID }));
    await settle();

    assert.deepEqual(modes, []);
    assert.equal(socket.frames.at(-1)?.code, 'PERMISSION_MODE_REQUIRED');
  });
});

test('a plan approval carries the mode to continue in', async () => {
  await withGateway(async ({ socket, decisions }) => {
    socket.emit('message', JSON.stringify({ type: 'chat.permission-response', requestId: 'r1', allow: true, permissionMode: 'auto' }));
    await settle();

    assert.equal(decisions.length, 1);
    assert.equal((decisions[0][1] as { permissionMode?: string }).permissionMode, 'auto');
  });
});
