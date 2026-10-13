import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { listBusyClaudeCliSessions } from '@/modules/providers/services/claude-cli-liveness.service.js';

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;

let fakeHomeDirectory = '';
let originalHomedir: typeof os.homedir;
let sessionsDirectory = '';

// The registry lives under os.homedir(), so point it at a throwaway home.
beforeEach(async () => {
  fakeHomeDirectory = await mkdtemp(path.join(os.tmpdir(), 'claude-cli-liveness-'));
  sessionsDirectory = path.join(fakeHomeDirectory, '.claude', 'sessions');
  await mkdir(sessionsDirectory, { recursive: true });

  originalHomedir = os.homedir;
  (os as any).homedir = () => fakeHomeDirectory;
});

afterEach(async () => {
  (os as any).homedir = originalHomedir;
  await rm(fakeHomeDirectory, { recursive: true, force: true });
});

/** Writes one registry file. `process.pid` is alive and procStart is omitted, so the /proc check is skipped. */
async function writeRegistryRecord(sessionId: string, fields: Record<string, unknown>): Promise<void> {
  await writeFile(
    path.join(sessionsDirectory, `${sessionId}-record.json`),
    JSON.stringify({ pid: process.pid, sessionId, ...fields }),
  );
}

test('a busy turn is timed from statusUpdatedAt, not from the process launch', { concurrency: false }, async () => {
  const now = Date.now();
  await writeRegistryRecord('long-running', {
    status: 'busy',
    startedAt: now - 45 * DAY,
    updatedAt: now - 5 * SECOND,
    statusUpdatedAt: now - 5 * SECOND,
  });

  const sessions = await listBusyClaudeCliSessions();

  assert.deepEqual(sessions, [{ providerSessionId: 'long-running', startedAt: now - 5 * SECOND }]);
});

test('a busy turn without statusUpdatedAt falls back to updatedAt', { concurrency: false }, async () => {
  const now = Date.now();
  await writeRegistryRecord('no-status-time', {
    status: 'busy',
    startedAt: now - 45 * DAY,
    updatedAt: now - 12 * SECOND,
  });

  const sessions = await listBusyClaudeCliSessions();

  assert.deepEqual(sessions, [{ providerSessionId: 'no-status-time', startedAt: now - 12 * SECOND }]);
});

test('a busy record with only startedAt uses startedAt', { concurrency: false }, async () => {
  const now = Date.now();
  await writeRegistryRecord('only-started', {
    status: 'busy',
    startedAt: now - 3 * SECOND,
  });

  const sessions = await listBusyClaudeCliSessions();

  assert.deepEqual(sessions, [{ providerSessionId: 'only-started', startedAt: now - 3 * SECOND }]);
});

test('a timestamp far in the future is skipped in favour of the next valid one', { concurrency: false }, async () => {
  const now = Date.now();
  await writeRegistryRecord('future-status', {
    status: 'busy',
    startedAt: now - 45 * DAY,
    updatedAt: now - 10 * SECOND,
    statusUpdatedAt: now + 60 * 60 * SECOND,
  });

  const sessions = await listBusyClaudeCliSessions();

  assert.deepEqual(sessions, [{ providerSessionId: 'future-status', startedAt: now - 10 * SECOND }]);
});

test('an idle session is not reported as busy', { concurrency: false }, async () => {
  const now = Date.now();
  await writeRegistryRecord('idle-session', {
    status: 'idle',
    startedAt: now - 45 * DAY,
    updatedAt: now - 5 * SECOND,
    statusUpdatedAt: now - 5 * SECOND,
  });

  const sessions = await listBusyClaudeCliSessions();

  assert.deepEqual(sessions, []);
});
