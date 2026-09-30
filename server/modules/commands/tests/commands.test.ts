import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { LLMProvider, SideQuestionOptions, SideQuestionOutcome } from '@/shared/types.js';

import { createCommandsRouter } from '../commands.routes.js';
import { createSideQuestionService } from '../side-question.service.js';

/**
 * Stands in for `providerModelsService`. `resolveSessionModel` mirrors the real
 * precedence closely enough for the command handlers: a model recorded for the
 * session wins, otherwise the client's requested model, otherwise the catalog
 * default.
 */
function createModelsService(sessionModels: Record<string, string> = {}) {
  return {
    getProviderModels: async () => ({
      OPTIONS: [{ value: 'default', label: 'Default' }],
      DEFAULT: 'default',
    }),
    getCurrentActiveModel: async () => ({ model: 'default' }),
    setSessionModel: () => null,
    resolveSessionModel: async (
      provider: string,
      options: { sessionId?: string | null; requestedModel?: string | null } = {},
    ) => {
      const recorded = options.sessionId ? sessionModels[options.sessionId] : undefined;
      const model = recorded || options.requestedModel || 'default';
      return {
        provider,
        sessionId: options.sessionId ?? null,
        model,
        source: model === 'default' ? 'default' : 'session',
      };
    },
    resolveResumeModel: async () => undefined,
  };
}

type SideQuestionCall = { provider: LLMProvider; sessionId: string; question: string; options: SideQuestionOptions };

/**
 * The real side-question service over a fake session index and runtime, which
 * records what reached the runtime and answers with `outcome`.
 */
function createSideQuestions(
  sessions: Record<string, { provider: LLMProvider; projectPath: string | null }> = {},
  outcome: SideQuestionOutcome = { status: 'answered', answer: '**yes**', source: 'live' },
) {
  const calls: SideQuestionCall[] = [];
  const service = createSideQuestionService({
    findSession: (sessionId) => sessions[sessionId] ?? null,
    askProvider: async (provider, sessionId, question, options) => {
      calls.push({ provider, sessionId, question, options });
      return outcome;
    },
  });
  return { service, calls };
}

async function executeCommand(
  commandName: string,
  context: Record<string, unknown>,
  sessionModels: Record<string, string> = {},
  { args = [], sideQuestions = createSideQuestions().service }: {
    args?: string[];
    sideQuestions?: ReturnType<typeof createSideQuestionService>;
  } = {},
): Promise<Record<string, unknown>> {
  const router = createCommandsRouter({
    sideQuestions,
    fileSystem: {
      readFile: async () => JSON.stringify({ name: 'claude-code-ui', version: '0.0.0-test' }),
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/home/test',
    appRoot: '/app',
    models: createModelsService(sessionModels) as never,
    runtime: {
      uptime: () => 0,
      memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
      version: 'v22', platform: 'linux', pid: 1,
    },
  });
  const app = express().use(express.json()).use('/api/commands', router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ commandName, args, context }),
    });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('models command returns models only for the active provider using injected catalog', async () => {
  const result = await executeCommand('/models', { provider: 'codex' });
  const data = result.data as Record<string, unknown>;
  assert.deepEqual(Object.keys(data.available as object), ['codex']);
});

test('models command falls back to claude for unsupported providers', async () => {
  const result = await executeCommand('/models', { provider: 'unknown-provider' });
  const data = result.data as { current: { provider: string } };
  assert.equal(data.current.provider, 'claude');
});

test('models command reports the model recorded for the session', async () => {
  const result = await executeCommand(
    '/models',
    { provider: 'claude', sessionId: 'session-1', model: 'sonnet' },
    { 'session-1': 'haiku' },
  );

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('models command reports the composer model for a chat with no session yet', async () => {
  const result = await executeCommand('/models', { provider: 'claude', model: 'haiku' });

  const data = result.data as { current: { model: string } };
  assert.equal(data.current.model, 'haiku');
});

test('cost and status commands report the same resolved model as /models', async () => {
  const context = { provider: 'claude', sessionId: 'session-1', model: 'sonnet' };
  const sessionModels = { 'session-1': 'haiku' };

  const cost = await executeCommand('/cost', context, sessionModels);
  const status = await executeCommand('/status', context, sessionModels);

  assert.equal((cost.data as { model: string }).model, 'haiku');
  assert.equal((status.data as { model: string }).model, 'haiku');
});

test('btw asks the session row\'s provider in its project folder, with the words rejoined', async () => {
  const { service, calls } = createSideQuestions({ 'session-1': { provider: 'claude', projectPath: '/work/app' } });

  const result = await executeCommand(
    '/btw',
    { provider: 'codex', sessionId: 'session-1', projectPath: '/client/path', model: 'haiku' },
    {},
    { args: ['what', 'is', 'it', 'doing?'], sideQuestions: service },
  );

  assert.deepEqual(calls, [{
    provider: 'claude',
    sessionId: 'session-1',
    question: 'what is it doing?',
    options: { cwd: '/work/app', model: 'haiku' },
  }]);
  assert.equal(result.action, 'btw');
  assert.deepEqual(result.data, {
    question: 'what is it doing?', status: 'answered', answer: '**yes**', source: 'live',
  });
});

test('btw falls back to the client\'s provider and folder for an unindexed session', async () => {
  const { service, calls } = createSideQuestions();

  await executeCommand(
    '/btw',
    { provider: 'claude', sessionId: 'native-id', projectPath: '/client/path' },
    {},
    { args: ['why?'], sideQuestions: service },
  );

  assert.equal(calls[0]?.provider, 'claude');
  assert.deepEqual(calls[0]?.options, { cwd: '/client/path', model: null });
});

test('btw without a question or a session never reaches the runtime', async () => {
  const { service, calls } = createSideQuestions();

  const empty = await executeCommand('/btw', { sessionId: 'session-1' }, {}, { sideQuestions: service });
  const noSession = await executeCommand('/btw', { provider: 'claude' }, {}, { args: ['hi'], sideQuestions: service });

  assert.equal(calls.length, 0);
  assert.equal((empty.data as { status: string }).status, 'empty_question');
  assert.equal((noSession.data as { status: string }).status, 'no_context');
  assert.match((noSession.data as { message: string }).message, /no conversation yet/);
});

test('btw reports a provider without side questions as unsupported', async () => {
  const { service } = createSideQuestions({}, { status: 'unsupported' });

  const result = await executeCommand('/btw', { provider: 'codex', sessionId: 's' }, {}, { args: ['hi'], sideQuestions: service });

  const data = result.data as { status: string; message: string };
  assert.equal(data.status, 'unsupported');
  assert.equal(data.message, '/btw is only available in Claude sessions.');
});
