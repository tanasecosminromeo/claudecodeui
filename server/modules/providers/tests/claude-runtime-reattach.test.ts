import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  findClaudeSessionElsewhere,
  listClaudeSDKBackgroundWork,
  reattachClaudeSDKSessions,
  sendClaudeSDKInput,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';
import { readProcessStartTime } from '@/shared/utils.js';

/**
 * After a restart the server reattaches to the Claude processes the previous
 * one left running, and picks up what each was doing from its record: a turn
 * still going, background tasks still outstanding, or an approval nobody can
 * answer any more. The SDK stream is scripted (`context.createQuery`), and a
 * `sleep` stands in for the live CLI process the record points at.
 */

type Harness = {
  sent: NormalizedMessage[];
  processing: boolean[];
  emit: (message: Record<string, unknown>) => void;
  released: () => boolean;
  interrupts: () => number;
  prompts: Array<Record<string, unknown>>;
};

async function withReattached(
  appSessionId: string,
  record: { turnActive: boolean; awaitingPermission?: boolean; tasks?: Array<Record<string, unknown>> },
  runTest: (harness: Harness) => Promise<void>,
): Promise<void> {
  const processesDir = await mkdtemp(path.join(os.tmpdir(), 'claude-reattach-'));
  const previous = { dir: process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR, enabled: process.env.CLOUDCLI_DETACHED_CLAUDE };
  process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR = processesDir;
  process.env.CLOUDCLI_DETACHED_CLAUDE = '1';

  const standIn = spawn('sleep', ['60'], { stdio: 'ignore' });
  const dir = path.join(processesDir, `${appSessionId}-x`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({
    appSessionId,
    providerSessionId: `native-${appSessionId}`,
    pid: standIn.pid,
    procStart: readProcessStartTime(standIn.pid as number),
    dir,
    startedAt: new Date().toISOString(),
    options: { cwd: processesDir, model: 'sonnet' },
    turnActive: record.turnActive,
    awaitingPermission: record.awaitingPermission ?? false,
    tasks: record.tasks ?? [],
  }));

  const queue: Array<Record<string, unknown> | null> = [];
  let wake: (() => void) | null = null;
  const state = { released: false, interrupts: 0 };
  const prompts: Array<Record<string, unknown>> = [];
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt }) => {
    void (async () => {
      for await (const message of prompt) { prompts.push(message as Record<string, unknown>); }
      state.released = true;
    })();
    const iterator = (async function* () {
      for (;;) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => { wake = resolve; });
          wake = null;
          continue;
        }
        const next = queue.shift();
        if (next === null || next === undefined) {
          return;
        }
        yield next;
      }
    })();
    return Object.assign(iterator, { interrupt: async () => { state.interrupts += 1; } });
  };

  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sid) => sessions.normalizeMessage(raw, sid),
    isProviderInstalled: async () => true,
    createQuery,
  };
  const sent: NormalizedMessage[] = [];
  const processing: boolean[] = [];
  const emit = (message: Record<string, unknown>) => { queue.push(message); wake?.(); };
  const end = () => { queue.push(null); wake?.(); };

  try {
    const count = await reattachClaudeSDKSessions(context, (sessionId, runState) => {
      assert.equal(sessionId, appSessionId);
      processing.push(runState.processing);
      return { send: (message: NormalizedMessage) => { sent.push(message); }, userId: null } as never;
    });
    assert.equal(count, 1);
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    await runTest({ sent, processing, emit, released: () => state.released, interrupts: () => state.interrupts, prompts });
  } finally {
    end();
    standIn.kill('SIGKILL');
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR = previous.dir;
    process.env.CLOUDCLI_DETACHED_CLAUDE = previous.enabled;
    await rm(processesDir, { recursive: true, force: true });
  }
}

const result = (sessionId: string) => ({ type: 'result', subtype: 'success', session_id: sessionId, result: 'ok', duration_ms: 1, num_turns: 1 });

test('a process that was mid-turn streams the rest of the turn into a running run', async () => {
  await withReattached('app-mid', { turnActive: true }, async ({ sent, processing, emit, prompts }) => {
    assert.deepEqual(processing, [true]);
    assert.deepEqual(prompts, [], 'a reattached process gets no new first message');
    assert.equal(sent.some((message) => message.kind === 'complete'), false);

    emit({ type: 'assistant', session_id: 'native-app-mid', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Finished.' }] } });
    emit(result('native-app-mid'));
    await new Promise((resolve) => { setTimeout(resolve, 30); });

    assert.ok(sent.some((message) => message.kind === 'text' && message.content === 'Finished.'));
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1);
  });
});

test('a process kept for background work keeps it, and takes the next message', async () => {
  const task = { taskId: 'watch1', toolUseId: 'toolu_w', taskType: 'local_bash', description: 'CYD crash watch', startedAt: 1 };
  await withReattached('app-bg', { turnActive: false, tasks: [task] }, async ({ sent, processing, released, prompts }) => {
    assert.deepEqual(processing, [false]);
    assert.equal(sent.filter((message) => message.kind === 'complete').length, 1, 'the idle run ends at once');
    assert.equal(released(), false, 'the watch keeps its process');
    assert.deepEqual(
      listClaudeSDKBackgroundWork().filter((entry) => entry.sessionId === 'app-bg').map((entry) => entry.tasks.map((t) => t.taskId)),
      [['watch1']],
    );

    // Same process, no second one: the session is CloudCLI's again.
    assert.deepEqual(findClaudeSessionElsewhere('app-bg', { resolveProviderSessionId: () => 'native-app-bg' } as never), []);
    assert.equal(await sendClaudeSDKInput('app-bg', 'still watching?', {}), true);
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    assert.equal(prompts.length, 1);
  });
});

test('a process with nothing left to do is let go', async () => {
  await withReattached('app-idle', { turnActive: false }, async ({ released }) => {
    assert.equal(released(), true);
  });
});

test('a turn stuck on an approval the old server asked for is stopped, with a note', async () => {
  await withReattached('app-perm', { turnActive: true, awaitingPermission: true }, async ({ sent, interrupts }) => {
    assert.equal(interrupts(), 1);
    const note = sent.find((message) => message.kind === 'error');
    assert.match(String(note?.content), /waiting for your approval when CloudCLI restarted/);
  });
});
