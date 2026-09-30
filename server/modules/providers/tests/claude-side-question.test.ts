import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLAUDE_PREDEFINED_MODELS } from '@/modules/providers/list/claude/claude-models.provider.js';
import { askClaudeSideQuestion, queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import type { AnyRecord, ProviderRuntimeContext } from '@/shared/types.js';

/**
 * `/btw` asks the session's live CLI process when there is one, and otherwise
 * a throwaway fork of its transcript. Both are driven through the runtime's
 * `context.createQuery` seam, so no CLI process is involved.
 */

type CreateQuery = NonNullable<ProviderRuntimeContext['createQuery']>;
type QueryCall = { prompt: unknown; options: AnyRecord };

function createContext(overrides: Partial<ProviderRuntimeContext> = {}): ProviderRuntimeContext {
  return {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async (_sessionId, requestedModel) => requestedModel ?? undefined,
    getProviderModels: async () => CLAUDE_PREDEFINED_MODELS as never,
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
    ...overrides,
  };
}

/** A one-shot fork that replays `messages` and records how it was built. */
function createForkQuery(messages: Array<Record<string, unknown>>): { createQuery: CreateQuery; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const createQuery: CreateQuery = ({ prompt, options }) => {
    calls.push({ prompt, options });
    return Object.assign((async function* () { yield* messages; })(), { interrupt: async () => {} });
  };
  return { createQuery, calls };
}

const answerMessages = (text: string) => [
  { type: 'system', subtype: 'init', session_id: 'fork-id' },
  { type: 'assistant', session_id: 'fork-id', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'fork-id' },
];

/**
 * Starts a turn whose scripted process stays up until the test ends it, with
 * `askSideQuestion` answering as `answerSideQuestion` says.
 */
async function withLiveTurn(
  sessionId: string,
  answerSideQuestion: (question: string) => Promise<{ response: string; synthetic: boolean } | null>,
  runTest: (sent: unknown[]) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-side-question-'));
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const sent: unknown[] = [];
  const createQuery: CreateQuery = () => Object.assign((async function* () {
    yield { type: 'system', subtype: 'init', session_id: `native-${sessionId}` };
    await finished;
  })(), { interrupt: async () => {}, askSideQuestion: answerSideQuestion });

  const done = queryClaudeSDK(
    'main task',
    { sessionId, cwd },
    { send: (message: unknown) => { sent.push(message); }, userId: null } as never,
    createContext({ createQuery }),
  );
  try {
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    await runTest(sent);
  } finally {
    finish();
    await done;
    await rm(cwd, { recursive: true, force: true });
  }
}

test('a running turn answers through its own process and sends nothing into the chat', async () => {
  const asked: string[] = [];
  await withLiveTurn('live-session', async (question) => {
    asked.push(question);
    return { response: 'It is refactoring the parser.', synthetic: false };
  }, async (sent) => {
    const sentBefore = sent.length;
    const fork = createForkQuery(answerMessages('unused'));

    const outcome = await askClaudeSideQuestion(
      'live-session', 'what are you doing?', {}, createContext({ createQuery: fork.createQuery }),
    );

    assert.deepEqual(outcome, { status: 'answered', answer: 'It is refactoring the parser.', source: 'live' });
    assert.deepEqual(asked, ['what are you doing?']);
    assert.equal(fork.calls.length, 0, 'no fork when the live process answers');
    assert.equal(sent.length, sentBefore, 'the answer never reaches the session stream');
  });
});

test('a live process with no answer falls back to a fork', async () => {
  await withLiveTurn('live-null-session', async () => null, async () => {
    const fork = createForkQuery(answerMessages('From the fork.'));

    const outcome = await askClaudeSideQuestion(
      'live-null-session', 'q', {}, createContext({ createQuery: fork.createQuery, resolveProviderSessionId: () => 'native-x' }),
    );

    assert.deepEqual(outcome, { status: 'answered', answer: 'From the fork.', source: 'fork' });
  });
});

test('an idle session is answered by an unsaved, tool-less fork of its transcript', async () => {
  const fork = createForkQuery(answerMessages('**Teal.**'));
  const resolvedFor: Array<[string | undefined, string | null | undefined]> = [];
  const context = createContext({
    createQuery: fork.createQuery,
    resolveProviderSessionId: (sessionId) => (sessionId === 'idle-session' ? 'native-idle' : null),
    resolveResumeModel: async (sessionId, requestedModel) => {
      resolvedFor.push([sessionId, requestedModel]);
      return 'claude-haiku-4-5-20251001';
    },
  });

  const outcome = await askClaudeSideQuestion('idle-session', 'favourite colour?', { cwd: '/work/app', model: 'sonnet' }, context);

  assert.deepEqual(outcome, { status: 'answered', answer: '**Teal.**', source: 'fork' });
  assert.deepEqual(resolvedFor, [['idle-session', 'sonnet']]);
  assert.equal(fork.calls.length, 1);
  const { prompt, options } = fork.calls[0]!;
  assert.equal(typeof prompt, 'string');
  assert.match(prompt as string, /side question/);
  assert.match(prompt as string, /favourite colour\?$/);
  assert.equal(options.resume, 'native-idle');
  assert.equal(options.forkSession, true);
  assert.equal(options.persistSession, false);
  assert.equal(options.maxTurns, 1);
  assert.deepEqual(options.tools, []);
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.mcpServers, undefined);
  assert.equal(options.cwd, '/work/app');
  assert.equal(options.model, 'claude-haiku-4-5-20251001');
  assert.equal((options.settings as AnyRecord).disableAllHooks, true);
  assert.notEqual(options.permissionMode, 'bypassPermissions');
});

test('a session with no provider transcript has nothing to ask about', async () => {
  const fork = createForkQuery(answerMessages('unused'));

  const outcome = await askClaudeSideQuestion('brand-new', 'q', {}, createContext({ createQuery: fork.createQuery }));

  assert.deepEqual(outcome, { status: 'no_context' });
  assert.equal(fork.calls.length, 0);
});

test('a fork that fails without answering surfaces the error', async () => {
  const fork = createForkQuery([
    { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found'] },
  ]);

  await assert.rejects(
    askClaudeSideQuestion('s', 'q', {}, createContext({ createQuery: fork.createQuery, resolveProviderSessionId: () => 'gone' })),
    /No conversation found/,
  );
});
