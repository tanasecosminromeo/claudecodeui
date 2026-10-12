import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionsDb,
  sideQuestionsDb,
} from '@/modules/database/index.js';

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'side-questions-db-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
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

const countRows = (sessionId: string): number =>
  (getConnection()
    .prepare('SELECT COUNT(*) AS count FROM side_questions WHERE session_id = ?')
    .get(sessionId) as { count: number }).count;

test('entries are listed oldest first and only the pending row can be answered or failed', async () => {
  await withDatabase(() => {
    sessionsDb.createSession('session-1', 'claude', '/workspace/demo-project', 'Demo');
    sessionsDb.createSession('session-2', 'claude', '/workspace/demo-project', 'Other');

    const first = sideQuestionsDb.create('session-1', 'first?');
    const second = sideQuestionsDb.create('session-1', 'second?');
    const third = sideQuestionsDb.create('session-1', 'third?');
    sideQuestionsDb.create('session-2', 'elsewhere?');

    assert.equal(first.status, 'pending');
    assert.equal(first.answer, null);

    const answered = sideQuestionsDb.markAnswered(first.id, '**yes**', 'live');
    assert.equal(answered?.status, 'answered');
    assert.equal(answered?.answer, '**yes**');
    assert.equal(answered?.source, 'live');
    assert.notEqual(answered?.answered_at, null);

    const failed = sideQuestionsDb.markFailed(second.id, 'CLI exited');
    assert.equal(failed?.status, 'failed');
    assert.equal(failed?.error, 'CLI exited');

    // Only a pending row can change state.
    assert.equal(sideQuestionsDb.markAnswered(second.id, 'late', 'fork'), null);
    assert.equal(sideQuestionsDb.markFailed(first.id, 'late'), null);

    const listed = sideQuestionsDb.listBySession('session-1');
    assert.deepEqual(listed.map((row) => row.id), [first.id, second.id, third.id]);
    assert.deepEqual(listed.map((row) => row.status), ['answered', 'failed', 'pending']);
    assert.equal(listed[1]?.answer, null);
  });
});

test('failPending fails only the pending entries and leaves answers alone', async () => {
  await withDatabase(() => {
    sessionsDb.createSession('session-1', 'claude', '/workspace/demo-project', 'Demo');
    const answered = sideQuestionsDb.create('session-1', 'done?');
    sideQuestionsDb.markAnswered(answered.id, 'yes', 'fork');
    const pendingA = sideQuestionsDb.create('session-1', 'a?');
    const pendingB = sideQuestionsDb.create('session-1', 'b?');

    const changed = sideQuestionsDb.failPending('Interrupted by a server restart');

    assert.equal(changed, 2);
    const listed = sideQuestionsDb.listBySession('session-1');
    assert.deepEqual(listed.map((row) => row.status), ['answered', 'failed', 'failed']);
    assert.equal(listed[0]?.answer, 'yes');
    assert.equal(listed[1]?.id, pendingA.id);
    assert.equal(listed[1]?.error, 'Interrupted by a server restart');
    assert.equal(listed[2]?.id, pendingB.id);
    assert.equal(sideQuestionsDb.failPending('again'), 0);
  });
});

test('deleting a session deletes its side questions and leaves other sessions alone', async () => {
  await withDatabase(() => {
    sessionsDb.createSession('session-gone', 'claude', '/workspace/demo-project', 'Gone');
    sessionsDb.createSession('session-kept', 'claude', '/workspace/demo-project', 'Kept');
    sideQuestionsDb.create('session-gone', 'one?');
    sideQuestionsDb.create('session-gone', 'two?');
    sideQuestionsDb.create('session-kept', 'kept?');
    assert.equal(countRows('session-gone'), 2);

    assert.equal(sessionsDb.deleteSessionById('session-gone'), true);

    assert.equal(countRows('session-gone'), 0);
    assert.deepEqual(sideQuestionsDb.listBySession('session-gone'), []);
    assert.equal(countRows('session-kept'), 1);
  });
});
