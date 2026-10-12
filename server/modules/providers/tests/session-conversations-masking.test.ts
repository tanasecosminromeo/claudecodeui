import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { searchConversations } from '@/modules/providers/services/session-conversations-search.service.js';

const SESSION_ID = 'claude-search-masking-session';
const FAKE_SECRET = 'FAKE_TEST_VALUE_not_a_real_key';
const FAKE_GITHUB_TOKEN = 'gh' + 'p_' + 'C'.repeat(36);

test('conversation search snippets never contain a secret value', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'search-masking-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    const transcriptPath = path.join(tempRoot, `${SESSION_ID}.jsonl`);
    const row = (uuid: string, role: 'user' | 'assistant', text: string) => JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: role,
      uuid,
      timestamp: '2026-10-12T08:00:00.000Z',
      cwd: tempRoot,
      sessionId: SESSION_ID,
      message: { role, content: [{ type: 'text', text }] },
    });
    await writeFile(transcriptPath, [
      row('u1', 'user', `Set the deploy variable: API_KEY=${FAKE_SECRET} in the file.`),
      row('a1', 'assistant', `The deploy token is ${FAKE_GITHUB_TOKEN}, keep it private.`),
      '',
    ].join('\n'), 'utf8');

    closeConnection();
    process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
    await initializeDatabase();
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Deploy session', now, now, transcriptPath);

    const search = await searchConversations('deploy', 10);
    const shown = JSON.stringify(search);
    assert.ok(shown.includes('deploy'), 'the search found the session');
    assert.equal(shown.includes(FAKE_SECRET), false);
    assert.equal(shown.includes(FAKE_GITHUB_TOKEN), false);
    assert.ok(shown.includes('API_KEY=••••'), 'the name stays visible with its value masked');
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});
