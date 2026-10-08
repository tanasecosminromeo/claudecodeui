import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';

const provider = new ClaudeSessionsProvider();
const SESSION_ID = 'claude-compaction-1';

/**
 * Both records that describe a compaction are `system` events, which normalized
 * to nothing before this: the boundary carries the numbers, the status says one
 * is running. Each becomes one ordinary assistant row, so a client that knows
 * nothing of `compact` still reads the sentence.
 */
test('a compact boundary becomes one row carrying its numbers', () => {
  const [row, ...rest] = provider.normalizeMessage({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'u-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    compactMetadata: {
      trigger: 'manual',
      preTokens: 335_402,
      postTokens: 10_120,
      durationMs: 142_000,
    },
  }, SESSION_ID);

  assert.equal(rest.length, 0);
  assert.equal(row.kind, 'text');
  assert.equal(row.role, 'assistant');
  assert.equal(row.content, 'Compacted · manual · 335k → 10k tokens · 2m 22s');
  assert.deepEqual(row.compact, {
    phase: 'done',
    trigger: 'manual',
    preTokens: 335_402,
    postTokens: 10_120,
    durationMs: 142_000,
  });
});

test('the live spelling of the metadata reads the same', () => {
  const [row] = provider.normalizeMessage({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 1_240_000, post_tokens: 18_000, duration_ms: 45_000 },
  }, SESSION_ID);

  assert.equal(row.content, 'Compacted · auto · 1.2M → 18k tokens · 45s');
  assert.equal(row.compact?.trigger, 'auto');
});

test('a boundary with no metadata still says a compaction happened', () => {
  const [row] = provider.normalizeMessage({
    type: 'system',
    subtype: 'compact_boundary',
  }, SESSION_ID);

  assert.equal(row.content, 'Compacted · auto');
  assert.equal(row.compact?.phase, 'done');
});

test('a compacting status becomes a running row, and other statuses none', () => {
  const [running] = provider.normalizeMessage({
    type: 'system',
    subtype: 'status',
    status: 'compacting',
  }, SESSION_ID);

  assert.equal(running.content, 'Compacting conversation…');
  assert.equal(running.compact?.phase, 'running');

  assert.deepEqual(
    provider.normalizeMessage({ type: 'system', subtype: 'status', status: 'requesting' }, SESSION_ID),
    [],
  );
});

test('a failed compaction says so, with the reason when there is one', () => {
  const [failed] = provider.normalizeMessage({
    type: 'system',
    subtype: 'status',
    compact_result: 'failed',
    compact_error: 'context still too large',
  }, SESSION_ID);

  assert.equal(failed.content, 'Compaction failed: context still too large');
  assert.equal(failed.compact?.phase, 'failed');
  assert.equal(failed.compact?.error, 'context still too large');
});

test('the summary keeps its flag, so the client can fold it into the row', () => {
  const [row] = provider.normalizeMessage({
    type: 'user',
    isCompactSummary: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation.' },
  }, SESSION_ID);

  assert.equal(row.role, 'assistant');
  assert.equal(row.isCompactSummary, true);
});

/**
 * A `/compact` the CLI refuses ("Not enough messages to compact.") writes no
 * status event to disk: only the command row and its reply, which current CLIs
 * file as a `system` `local_command` row. That reply used to normalize to
 * nothing, so a reload showed the command and no answer at all.
 */
const COMMAND_ROW = {
  type: 'user',
  uuid: 'cmd-1',
  timestamp: '2026-01-01T00:00:01.000Z',
  message: {
    role: 'user',
    content: '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>',
  },
};
const REFUSAL_ROW = {
  type: 'system',
  subtype: 'local_command',
  uuid: 'out-1',
  timestamp: '2026-01-01T00:00:02.000Z',
  level: 'info',
  isMeta: false,
  content: '<local-command-stdout>Not enough messages to compact.</local-command-stdout>',
};

test('a local command\'s output filed as a system row reads as its reply', () => {
  const [row, ...rest] = provider.normalizeMessage(REFUSAL_ROW, SESSION_ID);

  assert.equal(rest.length, 0);
  assert.equal(row.role, 'assistant');
  assert.equal(row.content, 'Not enough messages to compact.');
  assert.equal(row.isLocalCommandStdout, true);
});

async function historyOf(lines: unknown[]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'claude-compaction-'));
  const previousDatabasePath = process.env.DATABASE_PATH;
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try {
    const jsonlPath = path.join(directory, `${SESSION_ID}.jsonl`);
    const rows = lines.map((line) => JSON.stringify({ sessionId: SESSION_ID, ...(line as object) }));
    await writeFile(jsonlPath, `${rows.join('\n')}\n`);
    const now = new Date().toISOString();
    sessionsDb.createSession(SESSION_ID, 'claude', directory, 'Compaction', now, now, jsonlPath);
    const history = await new ClaudeSessionsProvider().fetchHistory(SESSION_ID, { providerSessionId: SESSION_ID });
    return history.messages;
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test('from history, a refused /compact is the command and one failed compaction row', { concurrency: false }, async () => {
  const messages = await historyOf([
    { type: 'user', uuid: 'u-0', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'hi' } },
    COMMAND_ROW,
    REFUSAL_ROW,
  ]);

  assert.deepEqual(messages.map((message) => message.content), [
    'hi',
    '/compact',
    'Compaction failed: Not enough messages to compact.',
  ]);
  assert.deepEqual(messages[2].compact, { phase: 'failed', error: 'Not enough messages to compact.' });
});

test('from history, the reply to a /compact that worked stays the one-word acknowledgement', { concurrency: false }, async () => {
  const messages = await historyOf([
    COMMAND_ROW,
    {
      type: 'user',
      uuid: 'out-2',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' },
    },
  ]);

  assert.equal(messages[1].content, 'Compacted');
  assert.equal(messages[1].compact, undefined);
});
