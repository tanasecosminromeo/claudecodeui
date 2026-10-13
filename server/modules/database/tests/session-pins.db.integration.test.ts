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
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'session-pins-db-'));

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

test('pinned_at column exists after migration and the setter pins and unpins a session', async () => {
  await withIsolatedDatabase(() => {
    const columns = getConnection().prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === 'pinned_at'));

    sessionsDb.createSession('session-pin-db', 'claude', '/workspace/demo-project', 'Pin db');
    assert.equal(sessionsDb.getSessionById('session-pin-db')?.pinned_at, null);

    sessionsDb.setSessionPinned('session-pin-db', true);
    assert.ok(sessionsDb.getSessionById('session-pin-db')?.pinned_at);

    sessionsDb.setSessionPinned('session-pin-db', false);
    assert.equal(sessionsDb.getSessionById('session-pin-db')?.pinned_at, null);
  });
});

test('a pinned session stays on the first page even when it is the oldest', async () => {
  await withIsolatedDatabase(() => {
    const projectPath = '/workspace/demo-project';
    for (let index = 0; index < 25; index += 1) {
      sessionsDb.createSession(`session-${String(index).padStart(2, '0')}`, 'claude', projectPath, `Session ${index}`);
    }

    // Give each row a distinct activity time: session-00 is the oldest.
    const db = getConnection();
    for (let index = 0; index < 25; index += 1) {
      db.prepare('UPDATE sessions SET updated_at = ? WHERE session_id = ?').run(
        `2026-10-01 10:${String(index).padStart(2, '0')}:00`,
        `session-${String(index).padStart(2, '0')}`,
      );
    }

    sessionsDb.setSessionPinned('session-00', true);

    const firstPage = sessionsDb.getSessionsByProjectPathPage(projectPath, 20, 0);
    assert.equal(firstPage[0]?.session_id, 'session-00');
    assert.equal(firstPage.length, 20);
    assert.equal(firstPage[1]?.session_id, 'session-24');

    const secondPage = sessionsDb.getSessionsByProjectPathPage(projectPath, 20, 20);
    assert.equal(secondPage.some((session) => session.session_id === 'session-00'), false);
  });
});
