import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import {
  abortClaudeSDKSession,
  listClaudeSDKBackgroundWork,
  queryClaudeSDK,
  sendClaudeSDKInput,
} from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { NormalizedMessage, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * One CLI process per session: a session's process outlives its turn while
 * background work is outstanding, and every message sent in that window —
 * mid-turn or between turns — goes into that same process instead of starting
 * a second one next to it. Two processes on one session both write the same
 * transcript and fork the conversation.
 *
 * Driven through `context.createQuery` with a scripted SDK stream, like the
 * hold tests: each spawned "process" records the prompt messages the runtime
 * feeds its stdin, so "which process got the message" is directly observable.
 */

const NATIVE_ID = 'native-live-session';

type ScriptedProcess = {
  emit: (message: Record<string, unknown>) => void;
  end: () => void;
  released: () => boolean;
  prompts: Array<Record<string, unknown>>;
  interrupts: number;
  /** Makes interrupt() throw, as the SDK does once its process is gone. */
  failInterrupt: boolean;
  models: string[];
  permissionModes: string[];
  options: Record<string, unknown>;
};

/** A createQuery that spawns a fresh scripted "process" per call and remembers them in order. */
function createProcessFactory(): {
  createQuery: NonNullable<ProviderRuntimeContext['createQuery']>;
  processes: ScriptedProcess[];
} {
  const processes: ScriptedProcess[] = [];

  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = ({ prompt, options }) => {
    const queue: Array<Record<string, unknown> | null> = [];
    let wake: (() => void) | null = null;
    let released = false;

    const scripted: ScriptedProcess = {
      emit: (message) => { queue.push(message); wake?.(); },
      end: () => { queue.push(null); wake?.(); },
      released: () => released,
      prompts: [],
      interrupts: 0,
      failInterrupt: false,
      models: [],
      permissionModes: [],
      options,
    };
    processes.push(scripted);

    void (async () => {
      for await (const message of prompt) {
        scripted.prompts.push(message as Record<string, unknown>);
      }
      released = true;
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

    return Object.assign(iterator, {
      interrupt: async () => {
        scripted.interrupts += 1;
        if (scripted.failInterrupt) {
          throw new Error('Operation aborted');
        }
      },
      stopTask: async () => {},
      setModel: async (model?: string) => { scripted.models.push(model ?? ''); },
      setPermissionMode: async (mode: string) => { scripted.permissionModes.push(mode); },
    });
  };

  return { createQuery, processes };
}

type Harness = {
  processes: ScriptedProcess[];
  /** Detached handles the runtime spawned, one per process, when the harness runs detached. */
  handles: DetachedHandle[];
  context: ProviderRuntimeContext;
  cwd: string;
  writer: () => { send: (message: NormalizedMessage) => void; sent: NormalizedMessage[]; userId: null };
};

type DetachedHandle = {
  pid: number;
  alive: boolean;
  kill: (signal: NodeJS.Signals) => boolean;
};

/** A stand-in CLI that never writes and only ends when its stdin does. */
const SILENT_CLI = { command: 'sh', args: ['-c', 'while IFS= read -r line; do :; done'] };

/**
 * Runs the test with the runtime spawning its processes detached, the way it
 * does in production: each "process" is a real `sh` with its own pipes, and
 * the scripted stream stands in for the SDK's reading of it.
 */
async function withDetachedHarness(runTest: (harness: Harness) => Promise<void>): Promise<void> {
  const processesDir = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-detached-'));
  const previous = {
    detached: process.env.CLOUDCLI_DETACHED_CLAUDE,
    dir: process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR,
    scope: process.env.CLOUDCLI_DETACHED_CLAUDE_SCOPE,
  };
  process.env.CLOUDCLI_DETACHED_CLAUDE = '1';
  process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR = processesDir;
  process.env.CLOUDCLI_DETACHED_CLAUDE_SCOPE = '0';
  try {
    await withHarness(runTest, { detached: true });
  } finally {
    process.env.CLOUDCLI_DETACHED_CLAUDE = previous.detached;
    process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR = previous.dir;
    process.env.CLOUDCLI_DETACHED_CLAUDE_SCOPE = previous.scope;
    await rm(processesDir, { recursive: true, force: true });
  }
}

async function withHarness(
  runTest: (harness: Harness) => Promise<void>,
  { detached = false }: { detached?: boolean } = {},
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-runtime-live-'));
  const { createQuery: createScriptedQuery, processes } = createProcessFactory();
  const handles: DetachedHandle[] = [];
  // The SDK spawns the process through the options; the detached case takes
  // that spawn for real, so the process exists and can be killed from outside.
  const createQuery: NonNullable<ProviderRuntimeContext['createQuery']> = (args) => {
    const scripted = createScriptedQuery(args);
    const spawn = args.options.spawnClaudeCodeProcess as ((request: Record<string, unknown>) => DetachedHandle) | undefined;
    if (detached && spawn) {
      handles.push(spawn({ ...SILENT_CLI, cwd, env: { ...process.env } }));
    }
    return scripted;
  };
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: (raw, sessionId) => sessions.normalizeMessage(raw, sessionId),
    isProviderInstalled: async () => true,
    createQuery,
  };
  const writer = () => {
    const sent: NormalizedMessage[] = [];
    return { send: (message: NormalizedMessage) => { sent.push(message); }, sent, userId: null };
  };

  try {
    await runTest({ processes, handles, context, cwd, writer });
  } finally {
    for (const process of processes) {
      process.end();
    }
    for (const handle of handles) {
      handle.kill('SIGKILL');
    }
    await settle();
    await rm(cwd, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 25); });

const init = () => ({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
const toolUse = (id: string, name: string, input: Record<string, unknown>) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const text = (value: string) => ({
  type: 'assistant', session_id: NATIVE_ID, parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text: value }] },
});
const taskStarted = (taskId: string, toolUseId: string) => ({
  type: 'system', subtype: 'task_started', session_id: NATIVE_ID, task_id: taskId, tool_use_id: toolUseId, description: `Task ${taskId}`, task_type: 'local_bash',
});
const result = () => ({ type: 'result', subtype: 'success', session_id: NATIVE_ID, result: 'ok', duration_ms: 1, num_turns: 1 });

/** Emits a turn that leaves one backgrounded command running, so the process is held. */
function emitTurnWithBackgroundCommand(process: ScriptedProcess, taskId: string): void {
  process.emit(init());
  process.emit(toolUse(`toolu_${taskId}`, 'Bash', { command: 'sleep 100', run_in_background: true }));
  process.emit(taskStarted(taskId, `toolu_${taskId}`));
  process.emit(result());
}

const promptText = (message: Record<string, unknown>) =>
  (message.message as { content: unknown }).content;

test('a message sent while background work holds the process goes into that process', async () => {
  await withHarness(async ({ processes, context, cwd, writer }) => {
    const sessionId = 'app-live-reuse';
    const firstWriter = writer();
    const firstTurn = queryClaudeSDK('start the watch', { sessionId, cwd }, firstWriter as never, context);
    await settle();
    emitTurnWithBackgroundCommand(processes[0], 'watch1');
    await firstTurn;

    const secondWriter = writer();
    const secondTurn = queryClaudeSDK('all good?', { sessionId, cwd }, secondWriter as never, context);
    await settle();

    assert.equal(processes.length, 1, 'no second process is spawned next to the held one');
    assert.deepEqual(processes[0].prompts.map(promptText), ['start the watch', 'all good?']);
    assert.equal(processes[0].released(), false);

    processes[0].emit(init());
    processes[0].emit(text('Still watching.'));
    processes[0].emit(result());
    await secondTurn;

    // The second turn streams to the writer of the run that asked for it.
    assert.ok(secondWriter.sent.some((message) => message.kind === 'complete'));
    assert.ok(secondWriter.sent.some((message) => message.kind === 'text' && message.content === 'Still watching.'));
    assert.equal(firstWriter.sent.filter((message) => message.kind === 'complete').length, 1);
  });
});

test('a run resolves when its turn ends, not when the held process exits', async () => {
  await withHarness(async ({ processes, context, cwd, writer }) => {
    const sessionId = 'app-live-resolve';
    let settled = false;
    const turn = queryClaudeSDK('start', { sessionId, cwd }, writer() as never, context)
      .then(() => { settled = true; });
    await settle();
    emitTurnWithBackgroundCommand(processes[0], 'bg1');
    await settle();

    assert.equal(settled, true);
    assert.equal(processes[0].released(), false, 'the process is still held for the command');
    await turn;
  });
});

test('a message sent mid-turn is pushed into the running turn', async () => {
  await withHarness(async ({ processes, context, cwd, writer }) => {
    const sessionId = 'app-live-midturn';
    const turn = queryClaudeSDK('run the tests', { sessionId, cwd }, writer() as never, context);
    await settle();
    processes[0].emit(init());
    processes[0].emit(toolUse('toolu_1', 'Bash', { command: 'npm test' }));
    await settle();

    assert.equal(await sendClaudeSDKInput(sessionId, 'also check lint', { cwd }), true);
    await settle();

    assert.equal(processes.length, 1);
    const pushed = processes[0].prompts[1];
    assert.equal(promptText(pushed), 'also check lint');
    // No priority: the CLI folds it into the running turn at its next step.
    // `now` would abort the step in progress and redo it.
    assert.equal(pushed.priority, undefined);

    processes[0].emit(result());
    await turn;
  });
});

/** Waits until the condition holds, polling fast: the exit poll that would clear the session runs every 500 ms. */
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condition not met in time');
    }
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

test('stopping a turn whose process already died clears the session as aborted', async () => {
  await withDetachedHarness(async ({ processes, handles, context, cwd, writer }) => {
    const sessionId = 'app-dead-abort';
    const turn = queryClaudeSDK('work', { sessionId, cwd }, writer() as never, context);
    await settle();
    processes[0].emit(init());
    await settle();

    // The process dies on its own; the interrupt that follows cannot reach it.
    process.kill(handles[0].pid, 'SIGKILL');
    await waitUntil(() => !handles[0].alive);
    processes[0].failInterrupt = true;

    assert.equal(await abortClaudeSDKSession(sessionId), true, 'the stop counts as an abort, so the aborted complete goes out');
    assert.equal(await sendClaudeSDKInput(sessionId, 'still there?', { cwd }), false, 'the session is gone');
    processes[0].emit(result());
    await turn;
  });
});

test('stopping a turn whose live process refuses the interrupt keeps the session', async () => {
  await withDetachedHarness(async ({ processes, handles, context, cwd, writer }) => {
    const sessionId = 'app-live-refused';
    const turn = queryClaudeSDK('work', { sessionId, cwd }, writer() as never, context);
    await settle();
    processes[0].emit(init());
    processes[0].failInterrupt = true;

    assert.equal(handles[0].alive, true);
    assert.equal(await abortClaudeSDKSession(sessionId), false, 'a live process that cannot be interrupted is not cleared');
    assert.equal(await sendClaudeSDKInput(sessionId, 'still there?', { cwd }), true, 'the session is still active');
    processes[0].emit(text('Still here.'));
    processes[0].emit(result());
    await turn;
  });
});

test('mid-turn input is refused when the session has no live process', async () => {
  assert.equal(await sendClaudeSDKInput('app-live-none', 'hello', {}), false);
});

test('stopping a turn keeps a process that still has background work', async () => {
  await withHarness(async ({ processes, context, cwd, writer }) => {
    const sessionId = 'app-live-abort-bg';
    const firstTurn = queryClaudeSDK('start', { sessionId, cwd }, writer() as never, context);
    await settle();
    emitTurnWithBackgroundCommand(processes[0], 'keep1');
    await firstTurn;

    const secondTurn = queryClaudeSDK('do more', { sessionId, cwd }, writer() as never, context);
    await settle();
    processes[0].emit(init());
    processes[0].emit(toolUse('toolu_2', 'Bash', { command: 'sleep 5' }));
    await settle();

    assert.equal(await abortClaudeSDKSession(sessionId), true);
    processes[0].emit({ type: 'result', subtype: 'error_during_execution', session_id: NATIVE_ID, duration_ms: 1, num_turns: 1 });
    await secondTurn;

    assert.equal(processes[0].interrupts, 1);
    assert.equal(processes[0].released(), false, 'the backgrounded command keeps running');
    assert.deepEqual(
      listClaudeSDKBackgroundWork().filter((entry) => entry.sessionId === sessionId).map((entry) => entry.tasks.map((task) => task.taskId)),
      [['keep1']],
    );

    // And the next message still lands in that same process.
    const thirdTurn = queryClaudeSDK('status?', { sessionId, cwd }, writer() as never, context);
    await settle();
    assert.equal(processes.length, 1);
    processes[0].emit(result());
    await thirdTurn;
  });
});

test('stopping a turn with nothing outstanding lets the process go', async () => {
  await withHarness(async ({ processes, context, cwd, writer }) => {
    const sessionId = 'app-live-abort-idle';
    const turn = queryClaudeSDK('long task', { sessionId, cwd }, writer() as never, context);
    await settle();
    processes[0].emit(init());
    await settle();

    assert.equal(await abortClaudeSDKSession(sessionId), true);
    await settle();
    assert.equal(processes[0].released(), true);
    processes[0].end();
    await turn;
  });
});

test('a model picked for the next turn is applied to the live process', async () => {
  await withHarness(async ({ processes, context, cwd, writer }) => {
    const sessionId = 'app-live-model';
    const firstTurn = queryClaudeSDK('start', { sessionId, cwd, model: 'sonnet' }, writer() as never, context);
    await settle();
    emitTurnWithBackgroundCommand(processes[0], 'm1');
    await firstTurn;

    const secondTurn = queryClaudeSDK('now think harder', { sessionId, cwd, model: 'opus', permissionMode: 'plan' }, writer() as never, context);
    await settle();

    assert.deepEqual(processes[0].models, ['opus']);
    assert.deepEqual(processes[0].permissionModes, ['plan']);
    processes[0].emit(result());
    await secondTurn;
  });
});

test('editing an earlier message replaces the live process instead of joining it', async () => {
  await withHarness(async ({ processes, context, cwd, writer }) => {
    const sessionId = 'app-live-edit';
    const firstTurn = queryClaudeSDK('start', { sessionId, cwd }, writer() as never, context);
    await settle();
    emitTurnWithBackgroundCommand(processes[0], 'e1');
    await firstTurn;

    // The edit rewrites the conversation from an earlier point, which the
    // live process cannot do — it has to be a fresh resume.
    const editTurn = queryClaudeSDK('start differently', { sessionId, cwd, resumeFromScratch: true }, writer() as never, context);
    await settle();
    processes[0].end();
    await settle();

    assert.equal(processes.length, 2);
    assert.equal(processes[0].released(), true);
    assert.deepEqual(processes[1].prompts.map(promptText), ['start differently']);
    processes[1].emit(init());
    processes[1].emit(result());
    await editTurn;
  });
});

test('a process that was let go does not hide a terminal on the session', async () => {
  const { spawn } = await import('node:child_process');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { findClaudeSessionElsewhere } = await import('@/modules/providers/list/claude/claude-runtime.provider.js');
  await withHarness(async ({ processes, context, cwd, writer }) => {
    const sessionId = 'app-live-released';
    const turn = queryClaudeSDK('hello', { sessionId, cwd }, writer() as never, context);
    await settle();
    processes[0].emit({ type: 'system', subtype: 'init', session_id: NATIVE_ID });
    processes[0].emit(result());
    await turn;
    await settle();
    assert.equal(processes[0].released(), true, 'nothing outstanding: the process was let go');

    // Meanwhile a terminal resumes the session — a process that is not this
    // server's child (its own children count as CloudCLI's).
    const launcher = spawn('sh', ['-c', 'sleep 60 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    const terminalPid = await new Promise<number>((resolve) => { launcher.stdout?.once('data', (data) => resolve(Number(String(data).trim()))); });
    const terminal = { pid: terminalPid, kill: (signal: NodeJS.Signals) => { try { process.kill(terminalPid, signal); } catch { /* gone */ } } };
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = cwd;
    try {
      await mkdir(path.join(cwd, 'sessions'));
      await writeFile(path.join(cwd, 'sessions', `${terminal.pid}.json`), JSON.stringify({ pid: terminal.pid, sessionId: NATIVE_ID, entrypoint: 'cli' }));
      const elsewhere = findClaudeSessionElsewhere(sessionId, { resolveProviderSessionId: () => NATIVE_ID } as never);
      assert.deepEqual(elsewhere.map((entry) => entry.pid), [terminal.pid]);
    } finally {
      terminal.kill('SIGKILL');
      if (previous === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previous;
      }
    }
  });
});

test('a message sent right after Stop waits for the stopped turn\'s result', async () => {
  await withHarness(async ({ processes, context, cwd, writer }) => {
    const sessionId = 'app-live-stop-then-send';
    const firstTurn = queryClaudeSDK('start', { sessionId, cwd }, writer() as never, context);
    await settle();
    emitTurnWithBackgroundCommand(processes[0], 'keep1');
    await firstTurn;

    // A turn the user stops: the chat gateway ends its run at once, but the
    // CLI's `result` for it is still on its way.
    const stoppedTurn = queryClaudeSDK('long task', { sessionId, cwd }, writer() as never, context);
    await settle();
    processes[0].emit(init());
    processes[0].emit(toolUse('toolu_2', 'Bash', { command: 'sleep 5' }));
    await settle();
    assert.equal(await abortClaudeSDKSession(sessionId), true);

    // The next message arrives before that result.
    const nextWriter = writer();
    const nextTurn = queryClaudeSDK('and now this', { sessionId, cwd }, nextWriter as never, context);
    await settle();
    assert.equal(processes[0].prompts.length, 2, 'the new message is held back until the stopped turn has ended');

    processes[0].emit({ type: 'result', subtype: 'error_during_execution', session_id: NATIVE_ID, duration_ms: 1, num_turns: 1 });
    await stoppedTurn;
    await settle();
    assert.equal(processes[0].prompts.length, 3, 'then it goes in');
    assert.equal(nextWriter.sent.filter((message) => message.kind === 'complete').length, 0, 'the stopped turn\'s result did not end the new turn');

    processes[0].emit(init());
    processes[0].emit(text('Done with this.'));
    processes[0].emit(result());
    await nextTurn;
    assert.equal(nextWriter.sent.filter((message) => message.kind === 'complete').length, 1, 'the new turn ends on its own result');
  });
});

test('a push that a result had already overtaken keeps the run open until the next result', async () => {
  await withHarness(async ({ processes, context, cwd, writer }) => {
    const sessionId = 'app-live-trailing-push';
    const turnWriter = writer();
    const turn = queryClaudeSDK('do it', { sessionId, cwd }, turnWriter as never, context);
    await settle();
    processes[0].emit(init());
    processes[0].emit(toolUse('toolu_1', 'Bash', { command: 'true' }));
    await settle();

    // The CLI had already written its result when this message went in.
    assert.equal(await sendClaudeSDKInput(sessionId, 'one more thing', { cwd }), true);
    processes[0].emit(result());
    await settle();
    assert.equal(turnWriter.sent.filter((message) => message.kind === 'complete').length, 0, 'the overtaken result does not end the run');
    assert.equal(processes[0].released(), false, 'and the process is not let go under the message');

    // The CLI takes the message as a new turn; that turn's result ends the run.
    processes[0].emit(init());
    processes[0].emit(text('One more thing done.'));
    processes[0].emit(result());
    await turn;
    assert.equal(turnWriter.sent.filter((message) => message.kind === 'complete').length, 1);
    assert.ok(turnWriter.sent.some((message) => message.kind === 'text' && message.content === 'One more thing done.'), 'streamed into the same run');
  });
});

/**
 * The CLI never folds `/`-leading text into the running turn: a `/compact`, a
 * skill, even `/tmp/x is a path` waits for the turn to end and then runs on
 * its own, ending in a `result` of its own. Settling on the turn's result let
 * the process go under that run — in detached mode, SIGTERM two seconds later,
 * mid-compaction.
 */
const compactingStatus = () => ({ type: 'system', subtype: 'status', status: 'compacting', session_id: NATIVE_ID });
const compactBoundary = () => ({
  type: 'system', subtype: 'compact_boundary', session_id: NATIVE_ID,
  compact_metadata: { trigger: 'manual', pre_tokens: 14_000, post_tokens: 2_000, duration_ms: 15_000 },
});

/** Starts a turn that is mid tool call, and pushes `pushed` into it. */
async function midTurnPush(harness: Harness, sessionId: string, pushed: string[]) {
  const turnWriter = harness.writer();
  const turn = queryClaudeSDK('run the slow command', { sessionId, cwd: harness.cwd }, turnWriter as never, harness.context);
  await settle();
  const cli = harness.processes[0];
  cli.emit(init());
  cli.emit(toolUse('toolu_1', 'Bash', { command: 'sleep 6' }));
  await settle();
  for (const text of pushed) {
    assert.equal(await sendClaudeSDKInput(sessionId, text, { cwd: harness.cwd }), true);
  }
  // The turn goes on after the push: the CLI is answering.
  cli.emit(text('FINISHED'));
  cli.emit(result());
  await settle();
  return { cli, turn, turnWriter, completes: () => turnWriter.sent.filter((message) => message.kind === 'complete').length };
}

test('a /compact sent mid-turn keeps the turn open through the run it starts after the result', async () => {
  await withHarness(async (harness) => {
    const { cli, turn, turnWriter, completes } = await midTurnPush(harness, 'app-live-midturn-compact', ['/compact focus on X']);

    assert.equal(completes(), 0, 'the turn\'s own result does not end the run');
    assert.equal(cli.released(), false, 'and the process is not let go under the queued command');

    cli.emit(compactingStatus());
    cli.emit(init());
    cli.emit(compactBoundary());
    cli.emit(result());
    await turn;

    assert.equal(completes(), 1, 'the command\'s result ends it');
    assert.equal(cli.released(), true, 'nothing outstanding: the process goes, as after any turn');
    const said = turnWriter.sent.filter((message) => message.kind === 'text').map((message) => message.content);
    assert.ok(said.includes('FINISHED'), 'the turn\'s own reply streamed');
    assert.ok(said.some((content) => content?.startsWith('Compacted · manual')), 'and so did the compaction');
  });
});

test('every slash command pushed mid-turn gets its own run before the turn settles', async () => {
  await withHarness(async (harness) => {
    const { cli, turn, completes } = await midTurnPush(harness, 'app-live-midturn-two', ['/compact', '/say-kiwi']);

    cli.emit(init());
    cli.emit(compactBoundary());
    cli.emit(result());
    await settle();
    assert.equal(completes(), 0, 'one command still to run');
    assert.equal(cli.released(), false);

    cli.emit(init());
    cli.emit(text('KIWI'));
    cli.emit(result());
    await turn;
    assert.equal(completes(), 1);
  });
});

test('plain text pushed mid-turn still settles on the turn\'s result', async () => {
  await withHarness(async (harness) => {
    const { turn, completes } = await midTurnPush(harness, 'app-live-midturn-plain', ['also check lint']);
    await turn;
    assert.equal(completes(), 1);
  });
});

test('a slash push the CLI answers with no run of its own still lets the turn end', async (t) => {
  await withHarness(async (harness) => {
    const { cli, turn, completes } = await midTurnPush(harness, 'app-live-midturn-silent', ['/compact']);
    assert.equal(completes(), 0);

    // Nothing follows the result: after the wait, the turn ends and the
    // process goes rather than being held for good.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      t.mock.timers.tick(20_000);
    } finally {
      t.mock.timers.reset();
    }
    await turn;
    assert.equal(completes(), 1);
    assert.equal(cli.released(), true);
  });
});

test('stopping the turn does not wait for a slash command pushed into it', async () => {
  await withHarness(async (harness) => {
    const sessionId = 'app-live-midturn-stop';
    const turnWriter = harness.writer();
    const turn = queryClaudeSDK('run the slow command', { sessionId, cwd: harness.cwd }, turnWriter as never, harness.context);
    await settle();
    const cli = harness.processes[0];
    cli.emit(init());
    cli.emit(toolUse('toolu_1', 'Bash', { command: 'sleep 6' }));
    await settle();
    assert.equal(await sendClaudeSDKInput(sessionId, '/compact', { cwd: harness.cwd }), true);
    cli.emit(text('stopping'));
    await settle();

    await abortClaudeSDKSession(sessionId);
    cli.emit(result());
    await turn;
    await settle();
    assert.equal(cli.released(), true, 'the stopped turn lets the process go on its result');
  });
});
