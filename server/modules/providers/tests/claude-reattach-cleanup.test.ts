import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { reattachClaudeSDKSessions } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/types.js';
import { isProcessAlive, readProcessStartTime } from '@/shared/utils.js';

/**
 * What a restarted server does with the processes it finds besides the ones
 * it reattaches: a process the old server had released (its SIGTERM never
 * came) is stopped, a duplicate on one session is stopped in favour of the
 * newest, and a process whose session is gone is stopped rather than left
 * running for good.
 */

async function withRecords(
  records: Array<{ appSessionId: string; released?: boolean; startedAt: string }>,
  runTest: (harness: { pids: number[]; attached: string[] }) => Promise<void>,
): Promise<void> {
  const processesDir = await mkdtemp(path.join(os.tmpdir(), 'claude-reattach-cleanup-'));
  const previous = process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR;
  process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR = processesDir;
  const standIns = records.map(() => spawn('sleep', ['60'], { stdio: 'ignore' }));
  const pids = standIns.map((child) => child.pid as number);

  records.forEach((record, index) => {
    const dir = path.join(processesDir, `${record.appSessionId}-${index}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({
      appSessionId: record.appSessionId,
      providerSessionId: `native-${record.appSessionId}`,
      pid: pids[index],
      procStart: readProcessStartTime(pids[index]),
      dir,
      startedAt: record.startedAt,
      options: { cwd: processesDir },
      turnActive: false,
      awaitingPermission: false,
      tasks: [],
      released: record.released ?? false,
    }));
  });

  const attached: string[] = [];
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sid) => sessions.normalizeMessage(raw, sid),
    isProviderInstalled: async () => true,
    createQuery: () => {
      // Never yields: a reattached stream that says nothing.
      const iterator = (async function* () { await new Promise(() => {}); yield undefined; })();
      return Object.assign(iterator, { interrupt: async () => {} });
    },
  };

  try {
    await reattachClaudeSDKSessions(context, (sessionId) => {
      if (sessionId === 'gone') {
        return null;
      }
      attached.push(sessionId);
      return { send: () => {}, userId: null } as never;
    });
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    await runTest({ pids, attached });
  } finally {
    for (const child of standIns) {
      child.kill('SIGKILL');
    }
    process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR = previous;
    await rm(processesDir, { recursive: true, force: true });
  }
}

test('a released process is stopped instead of reattached', async () => {
  await withRecords([{ appSessionId: 'app-a', released: true, startedAt: '2026-01-01T00:00:00Z' }], async ({ pids, attached }) => {
    assert.deepEqual(attached, []);
    assert.equal(isProcessAlive(pids[0]), false);
  });
});

test('two live processes on one session: the newest is reattached, the older stopped', async () => {
  await withRecords([
    { appSessionId: 'app-b', startedAt: '2026-01-01T00:00:00Z' },
    { appSessionId: 'app-b', startedAt: '2026-01-01T00:01:00Z' },
  ], async ({ pids, attached }) => {
    assert.deepEqual(attached, ['app-b']);
    assert.equal(isProcessAlive(pids[0]), false, 'the older one is stopped');
    assert.equal(isProcessAlive(pids[1]), true, 'the newest carries on');
  });
});

test('a process whose session no longer exists is stopped', async () => {
  await withRecords([{ appSessionId: 'gone', startedAt: '2026-01-01T00:00:00Z' }], async ({ pids, attached }) => {
    assert.deepEqual(attached, []);
    assert.equal(isProcessAlive(pids[0]), false);
  });
});
