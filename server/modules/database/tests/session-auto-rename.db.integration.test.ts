import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-auto-rename-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('migration adds the auto-rename columns to sessions, all NULL for new rows', async () => {
  await withIsolatedDatabase(() => {
    const columns = (getConnection().prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.equal(columns.includes('name_source'), true);
    assert.equal(columns.includes('status'), true);
    assert.equal(columns.includes('status_source'), true);
    assert.equal(columns.includes('auto_turns'), true);

    sessionsDb.createAppSession('app-session', 'claude', '/workspace/client-a');
    const row = sessionsDb.getSessionById('app-session');
    assert.equal(row?.name_source, null);
    assert.equal(row?.status, null);
    assert.equal(row?.status_source, null);
    assert.equal(row?.auto_turns, null);
  });
});

test('updateSessionCustomName records who set the name', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session', 'claude', '/workspace/client-a', 'First four words');

    sessionsDb.updateSessionCustomName('app-session', 'Manual name', 'user');
    assert.equal(sessionsDb.getSessionById('app-session')?.name_source, 'user');
    assert.equal(sessionsDb.getSessionById('app-session')?.custom_name, 'Manual name');

    sessionsDb.updateSessionCustomName('app-session', 'Generated name', 'auto');
    assert.equal(sessionsDb.getSessionById('app-session')?.name_source, 'auto');
    assert.equal(sessionsDb.getSessionById('app-session')?.custom_name, 'Generated name');
  });
});

test('markNameSourceUserIfUnset only fills an unset name source', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createSession('transcript-session', 'claude', '/workspace/client-a', 'From transcript');
    sessionsDb.markNameSourceUserIfUnset('transcript-session');
    assert.equal(sessionsDb.getSessionById('transcript-session')?.name_source, 'user');

    sessionsDb.createSession('auto-session', 'claude', '/workspace/client-a', 'Auto name');
    sessionsDb.updateSessionCustomName('auto-session', 'Auto name', 'auto');
    sessionsDb.markNameSourceUserIfUnset('auto-session');
    assert.equal(sessionsDb.getSessionById('auto-session')?.name_source, 'auto');
  });
});

test('updateSessionStatus stores the key and its source, and null clears the source only', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session', 'claude', '/workspace/client-a');

    sessionsDb.updateSessionStatus('app-session', 'testing', 'user');
    let row = sessionsDb.getSessionById('app-session');
    assert.equal(row?.status, 'testing');
    assert.equal(row?.status_source, 'user');

    sessionsDb.updateSessionStatus('app-session', 'testing', null);
    row = sessionsDb.getSessionById('app-session');
    assert.equal(row?.status, 'testing');
    assert.equal(row?.status_source, null);
  });
});

test('setSessionAutoTurns records the user-turn count of the last automatic run', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session', 'claude', '/workspace/client-a');
    sessionsDb.setSessionAutoTurns('app-session', 8);
    assert.equal(sessionsDb.getSessionById('app-session')?.auto_turns, 8);
  });
});
