import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import type { LLMProvider, SideQuestionEntry, SideQuestionOptions, SideQuestionOutcome } from '@/shared/types.js';

import { createCommandsRouter } from '../commands.routes.js';
import { createSideQuestionService } from '../side-question.service.js';

import { createMemorySideQuestionStore, flushBackground } from './side-question-fakes.js';

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
  sessions: Record<string, { provider: LLMProvider; projectPath: string | null; transcriptPath?: string | null }> = {},
  outcome: SideQuestionOutcome = { status: 'answered', answer: '**yes**', source: 'live' },
) {
  const calls: SideQuestionCall[] = [];
  const store = createMemorySideQuestionStore();
  const broadcasts: SideQuestionEntry[] = [];
  const service = createSideQuestionService({
    findSession: (sessionId) => {
      const session = sessions[sessionId];
      return session
        ? { sessionId, provider: session.provider, projectPath: session.projectPath, transcriptPath: session.transcriptPath ?? null }
        : null;
    },
    supportsSideQuestions: (provider) => provider === 'claude',
    askProvider: async (provider, sessionId, question, options) => {
      calls.push({ provider, sessionId, question, options });
      return outcome;
    },
    store,
    broadcast: (_sessionId, entry) => {
      broadcasts.push(entry);
    },
  });
  return { service, calls, store, broadcasts };
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
  return postCommands('execute', { commandName, args, context }, sessionModels, sideQuestions);
}

async function postCommands(
  route: 'list' | 'execute',
  body: Record<string, unknown>,
  sessionModels: Record<string, string> = {},
  sideQuestions: ReturnType<typeof createSideQuestionService> = createSideQuestions().service,
): Promise<Record<string, unknown>> {
  const response = await commandsRequest('POST', `${route}`, body, sessionModels, sideQuestions);
  assert.equal(response.status, 200);
  return response.body;
}

/** Sends one request to the commands router; returns the status and parsed JSON body. */
async function commandsRequest(
  method: 'GET' | 'POST',
  pathAndQuery: string,
  body: Record<string, unknown> | null,
  sessionModels: Record<string, string> = {},
  sideQuestions: ReturnType<typeof createSideQuestionService> = createSideQuestions().service,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const router = createCommandsRouter({
    sideQuestions,
    fileSystem: {
      readFile: async () => JSON.stringify({ name: 'claude-code-ui', version: '0.0.0-test' }),
      // No `.claude/commands` folder anywhere: only the server's own lists remain.
      access: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    } as unknown as typeof import('node:fs/promises'),
    homeDirectory: () => '/users/someone',
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
    const response = await fetch(`http://127.0.0.1:${address.port}/api/commands/${pathAndQuery}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
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
  const { service, calls, store } = createSideQuestions({ 'session-1': { provider: 'claude', projectPath: '/work/app' } });

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
  const data = result.data as { question: string; entry: SideQuestionEntry };
  assert.equal(data.question, 'what is it doing?');
  assert.equal(data.entry.status, 'pending');
  assert.equal(data.entry.saved, true);

  await flushBackground();
  assert.equal(store.rows[0]?.status, 'answered');
  assert.equal(store.rows[0]?.answer, '**yes**');
});

test('btw answers a session with no row in the response and stores nothing', async () => {
  const { service, store, broadcasts } = createSideQuestions();

  const result = await executeCommand('/btw', { provider: 'claude', sessionId: 'native-id' }, {}, { args: ['why?'], sideQuestions: service });

  const data = result.data as { question: string; entry: SideQuestionEntry };
  assert.equal(data.entry.status, 'answered');
  assert.equal(data.entry.answer, '**yes**');
  assert.equal(data.entry.saved, false);
  assert.equal(store.rows.length, 0);
  assert.equal(broadcasts.length, 0);
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

test('side-questions lists the session\'s entries oldest first with its transcript path', async () => {
  const { service } = createSideQuestions({
    'session-1': { provider: 'claude', projectPath: '/work/app', transcriptPath: '/transcripts/s1.jsonl' },
  });
  await executeCommand('/btw', { provider: 'claude', sessionId: 'session-1' }, {}, { args: ['first?'], sideQuestions: service });
  await flushBackground();
  await executeCommand('/btw', { provider: 'claude', sessionId: 'session-1' }, {}, { args: ['second?'], sideQuestions: service });
  await flushBackground();

  const response = await commandsRequest('GET', 'side-questions?sessionId=session-1', null, {}, service);

  assert.equal(response.status, 200);
  assert.equal(response.body.transcriptPath, '/transcripts/s1.jsonl');
  const entries = response.body.entries as SideQuestionEntry[];
  assert.deepEqual(entries.map((entry) => entry.question), ['first?', 'second?']);
  assert.deepEqual(entries.map((entry) => entry.status), ['answered', 'answered']);
  assert.equal(entries[0]?.sessionId, 'session-1');
  assert.equal(entries[0]?.saved, true);
});

test('side-questions answers 400 without a sessionId', async () => {
  const response = await commandsRequest('GET', 'side-questions', null);

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'sessionId is required');
});

type ListedCommand ={ name: string; description: string; namespace: string; metadata: { type: string } };

test('the list offers the Claude CLI\'s own commands apart from the built-ins, marked to pass through', async () => {
  const listed = await postCommands('list', { projectPath: '/work/app' });
  const cli = listed.cli as ListedCommand[];
  const builtIn = listed.builtIn as ListedCommand[];

  assert.deepEqual(cli.find((command) => command.name === '/compact'), {
    name: '/compact',
    description: 'Summarize the conversation to free up context (add focus instructions after it)',
    namespace: 'cli',
    metadata: { type: 'cli' },
  });
  assert.ok(cli.every((command) => command.namespace === 'cli' && command.metadata.type === 'cli'));
  // What the app answers itself is never handed to the CLI as well, and what
  // the app cannot follow (a new session, a terminal-only screen) is not offered.
  const builtInNames = new Set(builtIn.map((command) => command.name));
  assert.ok(cli.every((command) => !builtInNames.has(command.name)));
  for (const name of ['/clear', '/usage', '/cost', '/heapdump', '/usage-credits']) {
    assert.equal(cli.some((command) => command.name === name), false, `${name} is not offered`);
  }
  assert.equal((listed.custom as ListedCommand[]).some((command) => command.namespace === 'cli'), false);
});
