import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  findOtherLiveClaudeProcesses,
  stopClaudeProcesses,
} from '@/modules/providers/list/claude/claude-live-processes.js';
import { readProcessStartTime } from '@/shared/utils.js';

/**
 * The duplicate-session check reads Claude Code's own process registry. Stale
 * files, recycled pids and CloudCLI's own processes must not count as
 * "someone else has this session open".
 */

async function withRegistry(runTest: (write: (entry: Record<string, unknown>) => Promise<void>) => Promise<void>): Promise<void> {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'claude-live-'));
  await mkdir(path.join(configDir, 'sessions'));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    await runTest((entry) =>
      writeFile(path.join(configDir, 'sessions', `${String(entry.pid)}.json`), JSON.stringify(entry)));
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = previous;
    }
    await rm(configDir, { recursive: true, force: true });
  }
}

/** A stand-in for a terminal `claude`: a long sleep. */
function startStandIn() {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  return child;
}

/** A stand-in for a terminal `claude` started elsewhere: not this process's child. */
async function startForeignStandIn(): Promise<{ pid: number; kill: () => void }> {
  const launcher = spawn('sh', ['-c', 'sleep 60 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  const pid = await new Promise<number>((resolve) => { launcher.stdout?.once('data', (data) => resolve(Number(String(data).trim()))); });
  return { pid, kill: () => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } };
}

test('a live terminal process on the session is found', async () => {
  const terminal = await startForeignStandIn();
  try {
    await withRegistry(async (write) => {
      await write({ pid: terminal.pid, sessionId: 'native-1', procStart: readProcessStartTime(terminal.pid), entrypoint: 'cli', cwd: '/p' });
      await write({ pid: process.pid, sessionId: 'native-other', entrypoint: 'cli' });

      const found = findOtherLiveClaudeProcesses('native-1');
      assert.deepEqual(found.map((entry) => [entry.pid, entry.entrypoint, entry.cwd]), [[terminal.pid, 'cli', '/p']]);
    });
  } finally {
    terminal.kill();
  }
});

test('stale files, recycled pids and CloudCLI\'s own processes do not count', async () => {
  const own = startStandIn();
  try {
    await withRegistry(async (write) => {
      await write({ pid: 999999, sessionId: 'native-1', entrypoint: 'cli' });
      await write({ pid: process.pid, sessionId: 'native-1', procStart: '1', entrypoint: 'cli' });
      await write({ pid: own.pid, sessionId: 'native-1', entrypoint: 'sdk-ts' });

      assert.deepEqual(findOtherLiveClaudeProcesses('native-1', new Set([own.pid as number])), []);
    });
  } finally {
    own.kill('SIGKILL');
  }
});

test('taking a session over stops the other process', async () => {
  const terminal = startStandIn();
  const exited = new Promise((resolve) => { terminal.once('exit', resolve); });
  await stopClaudeProcesses([{ pid: terminal.pid as number, sessionId: 'native-1', entrypoint: 'cli', cwd: null, startedAt: null }]);
  await exited;
  assert.notEqual(terminal.exitCode ?? terminal.signalCode, null);
});

test('this server\'s own child process is not someone else on the session', async () => {
  const child = startStandIn();
  try {
    await withRegistry(async (write) => {
      await write({ pid: child.pid, sessionId: 'native-1', entrypoint: 'sdk-ts' });
      assert.deepEqual(findOtherLiveClaudeProcesses('native-1'), []);
    });
  } finally {
    child.kill('SIGKILL');
  }
});

test('the shell tab\'s guard also sees this server\'s own process on the session', async () => {
  const child = startStandIn();
  try {
    await withRegistry(async (write) => {
      await write({ pid: child.pid, sessionId: 'native-1', entrypoint: 'sdk-ts' });
      const found = findOtherLiveClaudeProcesses('native-1', new Set(), { includeOwnChildren: true });
      assert.deepEqual(found.map((entry) => [entry.pid, entry.entrypoint]), [[child.pid, 'sdk-ts']]);
    });
  } finally {
    child.kill('SIGKILL');
  }
});
