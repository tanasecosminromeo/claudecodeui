import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  attachDetachedClaude,
  listDetachedClaudeRecords,
  markDetachedClaudeShutdown,
  parseScopeExitReason,
  spawnDetachedClaude,
  unexpectedExitMessage,
} from '@/modules/providers/list/claude/claude-detached-process.js';

/**
 * A detached process survives the server that started it: the server's ends
 * of the pipes can go away without the process noticing, and a later server
 * reattaches from the record. Driven with a stand-in "CLI" that echoes each
 * line it reads, so the pipes are exercised for real without a Claude binary.
 */

const ECHO_CLI = { command: 'sh', args: ['-c', 'while IFS= read -r line; do echo "echo:$line"; done'] };

async function withProcessesDir(runTest: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'claude-detached-'));
  const previous = { dir: process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR, scope: process.env.CLOUDCLI_DETACHED_CLAUDE_SCOPE };
  process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR = dir;
  // The scope needs a user systemd; the pipes are what is under test here.
  process.env.CLOUDCLI_DETACHED_CLAUDE_SCOPE = '0';
  try {
    await runTest(dir);
  } finally {
    for (const record of listDetachedClaudeRecords()) {
      try { process.kill(record.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR = previous.dir;
    process.env.CLOUDCLI_DETACHED_CLAUDE_SCOPE = previous.scope;
    await rm(dir, { recursive: true, force: true });
  }
}

/** Resolves with the next line the process writes. */
function nextLine(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let buffered = '';
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf('\n');
      if (newline !== -1) {
        stream.off('data', onData);
        resolve(buffered.slice(0, newline));
      }
    };
    stream.on('data', onData);
  });
}

const waitFor = async (condition: () => boolean, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
};

const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a detached process talks through its pipes and records itself', async () => {
  await withProcessesDir(async () => {
    const handle = spawnDetachedClaude('app-1', { ...ECHO_CLI, env: { ...process.env } }, { model: 'm' }, 'native-1');
    handle.stdin.write('hello\n');
    assert.equal(await nextLine(handle.stdout), 'echo:hello');

    const [record] = listDetachedClaudeRecords();
    assert.equal(record.appSessionId, 'app-1');
    assert.equal(record.providerSessionId, 'native-1');
    assert.deepEqual(record.options, { model: 'm' });
    assert.equal(isAlive(record.pid), true);

    handle.updateRecord({ turnActive: false, tasks: [{ taskId: 't1' }] });
    assert.deepEqual(listDetachedClaudeRecords()[0].tasks, [{ taskId: 't1' }]);
    handle.stdout.destroy();
    handle.stdin.destroy();
  });
});

test('the process outlives its server and a new one reattaches', async () => {
  await withProcessesDir(async () => {
    const first = spawnDetachedClaude('app-2', { ...ECHO_CLI, env: { ...process.env } }, {}, null);
    first.stdin.write('one\n');
    assert.equal(await nextLine(first.stdout), 'echo:one');

    // The server goes away: its ends of the pipes close without a clean end.
    first.stdout.destroy();
    first.stdin.destroy();
    await new Promise((resolve) => { setTimeout(resolve, 300); });

    const [record] = listDetachedClaudeRecords();
    assert.ok(record, 'the process is still recorded as running');
    assert.equal(isAlive(record.pid), true);

    const second = attachDetachedClaude(record);
    second.stdin.write('two\n');
    assert.equal(await nextLine(second.stdout), 'echo:two');
    second.stdout.destroy();
    second.stdin.destroy();
  });
});

test('ending stdin on purpose ends the process and cleans up after it', async () => {
  await withProcessesDir(async (dir) => {
    const handle = spawnDetachedClaude('app-3', { ...ECHO_CLI, env: { ...process.env } }, {}, null);
    handle.stdin.write('x\n');
    await nextLine(handle.stdout);
    const [record] = listDetachedClaudeRecords();

    let exitArgs: unknown[] | null = null;
    handle.once('exit', (...args: unknown[]) => { exitArgs = args; });
    handle.stdin.end();

    await waitFor(() => exitArgs !== null);
    assert.deepEqual(exitArgs, [0, null], 'a process let go on purpose exits cleanly');
    assert.equal(isAlive(record.pid), false);
    assert.deepEqual(fs.readdirSync(dir), [], 'pipes and record are removed');
  });
});

test('a process that dies on its own ends its stream and is reported as killed', async () => {
  await withProcessesDir(async () => {
    const handle = spawnDetachedClaude('app-5', { ...ECHO_CLI, env: { ...process.env } }, {}, null);
    handle.stdin.write('x\n');
    await nextLine(handle.stdout);
    const [record] = listDetachedClaudeRecords();
    // Something must consume the stream for 'end' to be emitted at all.
    handle.stdout.on('data', () => {});

    let exitArgs: unknown[] | null = null;
    handle.once('exit', (...args: unknown[]) => { exitArgs = args; });
    let ended = false;
    handle.stdout.once('end', () => { ended = true; });

    // The OOM killer or a crash: nobody asked the process to stop.
    process.kill(record.pid, 'SIGKILL');
    await waitFor(() => exitArgs !== null);
    await waitFor(() => ended, 2000);

    assert.deepEqual(exitArgs, [null, 'SIGKILL'], 'the exit says it was killed, so the SDK raises an error');
    assert.equal(handle.killed, true);
    assert.equal(handle.exitCode, null);
    // Not this server's child and no scope here: the reason is not knowable.
    assert.equal(await handle.unexpectedExit, 'unknown');
  });
});

test('a process that dies on its own is logged with the reason and its scope unit', async () => {
  await withProcessesDir(async (dir) => {
    // A stand-in for `systemd-run --user --scope`: it drops the flags and runs the command.
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'systemd-run'), [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then exit 0; fi',
      'while [ $# -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done',
      'exec "$@"',
      '',
    ].join('\n'));
    fs.chmodSync(path.join(bin, 'systemd-run'), 0o755);
    const previousPath = process.env.PATH;
    const previousScope = process.env.CLOUDCLI_DETACHED_CLAUDE_SCOPE;
    process.env.PATH = `${bin}:${previousPath}`;
    process.env.CLOUDCLI_DETACHED_CLAUDE_SCOPE = '1';
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const handle = spawnDetachedClaude('app-6', { ...ECHO_CLI, env: { ...process.env } }, {}, null);
      handle.stdin.write('x\n');
      await nextLine(handle.stdout);
      const [record] = listDetachedClaudeRecords();
      assert.equal(record.unit, `cloudcli-claude-${path.basename(record.dir)}`);

      handle.stdout.on('data', () => {});
      process.kill(record.pid, 'SIGKILL');
      await waitFor(() => handle.killed);
      assert.equal(await handle.unexpectedExit, 'unknown', 'no journal entry for the unit');
      const expected = `[Claude detached] process ${record.pid} for session app-6 exited unexpectedly: unknown`;
      assert.ok(warnings.some((line) => line.includes(expected)), `logged: ${warnings.join(' | ')}`);
    } finally {
      console.warn = warn;
      process.env.PATH = previousPath;
      process.env.CLOUDCLI_DETACHED_CLAUDE_SCOPE = previousScope;
    }
  });
});

test('the journal lines of a scope are read for the reason it stopped', () => {
  assert.equal(
    parseScopeExitReason("A process of this unit has been killed by the OOM killer.\ncloudcli-claude-x.scope: Failed with result 'oom-kill'."),
    'oom-kill',
  );
  assert.equal(parseScopeExitReason("cloudcli-claude-x.scope: Failed with result 'signal'."), 'signal');
  assert.equal(parseScopeExitReason('Started cloudcli-claude-x.scope.'), 'unknown');
  assert.equal(parseScopeExitReason(''), 'unknown');
});

test('the user sees a readable reason for an OOM kill, and a generic text otherwise', () => {
  assert.match(unexpectedExitMessage('oom-kill'), /ran out of memory.*\(oom-kill\)\. Send a message to start it again\./);
  assert.equal(unexpectedExitMessage('unknown'), 'The Claude process stopped unexpectedly. Send a message to start it again.');
});

// Last: the shutdown flag cannot be cleared again within this process.
test('a server that is shutting down never kills a detached process', async () => {
  await withProcessesDir(async () => {
    const handle = spawnDetachedClaude('app-4', { ...ECHO_CLI, env: { ...process.env } }, {}, null);
    handle.stdin.write('x\n');
    await nextLine(handle.stdout);
    const [record] = listDetachedClaudeRecords();

    markDetachedClaudeShutdown();
    // What the SDK does to every child on exit, and what a release does.
    assert.equal(handle.kill('SIGTERM'), false);
    handle.stdin.end();
    await new Promise((resolve) => { setTimeout(resolve, 2500); });

    assert.equal(isAlive(record.pid), true);
    handle.stdout.destroy();
  });
});

test('a launch that fails is an error for the caller, not a crash of the server', async () => {
  await withProcessesDir(async () => {
    let uncaught: unknown = null;
    const onUncaught = (error: unknown) => { uncaught = error; };
    process.on('uncaughtException', onUncaught);
    try {
      assert.throws(
        () => spawnDetachedClaude('app-bad-cwd', { ...ECHO_CLI, cwd: '/nonexistent/project/folder', env: { ...process.env } }, {}, null),
        /Could not start the Claude process/,
      );
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      assert.equal(uncaught, null, 'the spawn error was handled');
      assert.deepEqual(listDetachedClaudeRecords(), []);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});
