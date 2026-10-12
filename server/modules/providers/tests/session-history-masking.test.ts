import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

const SESSION_ID = 'claude-masking-session';
const FAKE_SECRET = 'FAKE_TEST_VALUE_not_a_real_key';
const FAKE_GITHUB_TOKEN = 'gh' + 'p_' + 'B'.repeat(36);

const row = (uuid: string, role: 'user' | 'assistant', content: unknown) => ({
  parentUuid: null,
  isSidechain: false,
  type: role,
  uuid,
  timestamp: '2026-10-12T08:00:00.000Z',
  cwd: '/workspace/demo',
  sessionId: SESSION_ID,
  message: { role, content },
});

test('history hides a protected file read and masks secrets in text, on full and paged loads', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'history-masking-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  try {
    const protectedFile = path.join(os.homedir(), '.ssh', 'id_ed25519');
    const transcriptPath = path.join(tempRoot, `${SESSION_ID}.jsonl`);
    await writeFile(transcriptPath, [
      JSON.stringify(row('u1', 'user', 'Show me the key.')),
      JSON.stringify(row('a1', 'assistant', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `cat ${protectedFile}` } },
      ])),
      JSON.stringify(row('u2', 'user', [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: `FAKE KEY BODY ${FAKE_SECRET}` },
      ])),
      JSON.stringify(row('a2', 'assistant', [
        { type: 'text', text: `Use ${FAKE_GITHUB_TOKEN} to clone.` },
      ])),
      '',
    ].join('\n'), 'utf8');

    closeConnection();
    process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
    await initializeDatabase();
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', tempRoot, 'Masking session', now, now, transcriptPath);

    const full = await sessionsService.fetchHistory(SESSION_ID);
    const paged = await sessionsService.fetchHistory(SESSION_ID, { limit: 2, offset: 0 });
    for (const result of [full, paged]) {
      const shown = JSON.stringify(result.messages);
      assert.equal(shown.includes(FAKE_SECRET), false);
      assert.equal(shown.includes(FAKE_GITHUB_TOKEN), false);
    }
    assert.equal(JSON.stringify(full.messages).includes(protectedFile), true, 'the path of the protected read stays visible');
    // The tool result is merged into its call, so three rows: user, call, reply.
    assert.equal(full.total, 3, 'masking leaves the message count alone');
    assert.equal(paged.messages.length, 2);
    assert.equal(paged.total, full.total);
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
