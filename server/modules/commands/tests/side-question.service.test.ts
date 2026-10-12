import assert from 'node:assert/strict';
import test from 'node:test';

import type { LLMProvider, SideQuestionEntry, SideQuestionOptions, SideQuestionOutcome } from '@/shared/types.js';

import { createSideQuestionService, SIDE_QUESTION_MESSAGES } from '../side-question.service.js';

import { createMemorySideQuestionStore, flushBackground } from './side-question-fakes.js';

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CLAUDE_SESSION = { sessionId: 'session-1', provider: 'claude' as LLMProvider, projectPath: '/work/app', transcriptPath: '/transcripts/s1.jsonl' };

/**
 * The service over a fake session index, the in-memory store and a runtime
 * whose answer the test controls through `askProvider`.
 */
function createHarness(
  session: typeof CLAUDE_SESSION | null,
  askProvider: (provider: LLMProvider, sessionId: string, question: string, options: SideQuestionOptions) => Promise<SideQuestionOutcome>,
) {
  const store = createMemorySideQuestionStore();
  const broadcasts: Array<{ sessionId: string; entry: SideQuestionEntry }> = [];
  const asked: Array<{ provider: LLMProvider; sessionId: string; question: string; options: SideQuestionOptions }> = [];
  const service = createSideQuestionService({
    findSession: () => session,
    supportsSideQuestions: (provider) => provider === 'claude',
    askProvider: (provider, sessionId, question, options) => {
      asked.push({ provider, sessionId, question, options });
      return askProvider(provider, sessionId, question, options);
    },
    store,
    broadcast: (sessionId, entry) => {
      broadcasts.push({ sessionId, entry });
    },
  });
  return { service, store, broadcasts, asked };
}

const request = (question: string, sessionId: string | null = 'session-1') => ({
  sessionId,
  question,
  provider: 'claude' as LLMProvider,
  projectPath: '/client/path',
  model: 'haiku',
});

test('ask returns the pending entry before the provider answers, then records the answer and broadcasts both states', async () => {
  const answer = deferred<SideQuestionOutcome>();
  const { service, store, broadcasts, asked } = createHarness(CLAUDE_SESSION, () => answer.promise);

  const result = await service.ask(request('what is it doing?'));

  assert.ok('entry' in result);
  assert.equal(result.entry.status, 'pending');
  assert.equal(result.entry.saved, true);
  assert.equal(result.entry.question, 'what is it doing?');
  assert.equal(result.entry.sessionId, 'session-1');
  assert.deepEqual(asked, [{
    provider: 'claude',
    sessionId: 'session-1',
    question: 'what is it doing?',
    options: { cwd: '/work/app', model: 'haiku' },
  }]);
  assert.deepEqual(broadcasts.map((event) => event.entry.status), ['pending']);
  assert.equal(store.rows[0]?.status, 'pending');

  answer.resolve({ status: 'answered', answer: '**yes**', source: 'live' });
  await flushBackground();

  assert.equal(store.rows[0]?.status, 'answered');
  assert.equal(store.rows[0]?.answer, '**yes**');
  assert.equal(store.rows[0]?.source, 'live');
  assert.deepEqual(broadcasts.map((event) => event.entry.status), ['pending', 'answered']);
  assert.equal(broadcasts[1]?.sessionId, 'session-1');
  assert.equal(broadcasts[1]?.entry.answer, '**yes**');
  assert.equal(broadcasts[1]?.entry.source, 'live');
  assert.notEqual(broadcasts[1]?.entry.answeredAt, null);
});

test('a provider that throws marks the entry failed with its message', async () => {
  const { service, store, broadcasts } = createHarness(CLAUDE_SESSION, async () => {
    throw new Error('CLI exited with code 1');
  });

  const result = await service.ask(request('why?'));
  assert.ok('entry' in result);
  await flushBackground();

  assert.equal(store.rows[0]?.status, 'failed');
  assert.equal(store.rows[0]?.error, 'CLI exited with code 1');
  assert.deepEqual(broadcasts.map((event) => event.entry.status), ['pending', 'failed']);
  assert.equal(broadcasts[1]?.entry.error, 'CLI exited with code 1');
});

test('a non-answer outcome after the entry is stored marks it failed with the matching wording', async () => {
  const { service, store, broadcasts } = createHarness(CLAUDE_SESSION, async () => ({ status: 'no_context' }));

  await service.ask(request('still there?'));
  await flushBackground();

  assert.equal(store.rows[0]?.status, 'failed');
  assert.equal(store.rows[0]?.error, SIDE_QUESTION_MESSAGES.no_context);
  assert.equal(broadcasts[1]?.entry.error, SIDE_QUESTION_MESSAGES.no_context);
});

test('empty questions, questions without a session and unsupported providers are not stored or sent', async () => {
  const { service, store, broadcasts, asked } = createHarness(CLAUDE_SESSION, async () => ({ status: 'answered', answer: 'x', source: 'live' }));

  assert.deepEqual(await service.ask(request('   ')), { status: 'empty_question' });
  assert.deepEqual(await service.ask(request('hi', null)), { status: 'no_context' });

  const codexSession = { ...CLAUDE_SESSION, provider: 'codex' as LLMProvider };
  const codex = createHarness(codexSession, async () => ({ status: 'answered', answer: 'x', source: 'live' }));
  assert.deepEqual(await codex.service.ask(request('hi')), { status: 'unsupported' });

  assert.equal(store.rows.length, 0);
  assert.equal(broadcasts.length, 0);
  assert.equal(asked.length, 0);
  assert.equal(codex.store.rows.length, 0);
  assert.equal(codex.broadcasts.length, 0);
  assert.equal(codex.asked.length, 0);
});

test('a session with no row answers in the response, unsaved, with a negative id and nothing sent', async () => {
  const { service, store, broadcasts } = createHarness(null, async () => ({ status: 'answered', answer: '**maybe**', source: 'fork' }));

  const result = await service.ask(request('native id?', 'native-id'));

  assert.ok('entry' in result);
  assert.equal(result.entry.status, 'answered');
  assert.equal(result.entry.answer, '**maybe**');
  assert.equal(result.entry.source, 'fork');
  assert.equal(result.entry.saved, false);
  assert.ok(result.entry.id < 0);
  assert.equal(result.entry.sessionId, 'native-id');
  assert.equal(store.rows.length, 0);
  assert.equal(broadcasts.length, 0);
});

test('a session with no row whose provider throws comes back as a failed, unsaved entry', async () => {
  const { service, store } = createHarness(null, async () => {
    throw new Error('fork failed');
  });

  const result = await service.ask(request('native id?', 'native-id'));

  assert.ok('entry' in result);
  assert.equal(result.entry.status, 'failed');
  assert.equal(result.entry.error, 'fork failed');
  assert.equal(result.entry.saved, false);
  assert.equal(store.rows.length, 0);
});

test('a session with no row reports a non-answer outcome as the outcome itself', async () => {
  const { service } = createHarness(null, async () => ({ status: 'unsupported' }));

  assert.deepEqual(await service.ask(request('hi', 'native-id')), { status: 'unsupported' });
});

test('list returns the stored entries oldest first with the transcript path', async () => {
  const { service, store } = createHarness(CLAUDE_SESSION, async () => ({ status: 'answered', answer: 'a', source: 'live' }));

  await service.ask(request('first'));
  await flushBackground();
  await service.ask(request('second'));
  await flushBackground();
  store.create('other-session', 'elsewhere');

  const listed = service.list('session-1');

  assert.deepEqual(listed.entries.map((entry) => entry.question), ['first', 'second']);
  assert.deepEqual(listed.entries.map((entry) => entry.status), ['answered', 'answered']);
  assert.ok(listed.entries.every((entry) => entry.saved));
  assert.equal(listed.transcriptPath, '/transcripts/s1.jsonl');
});
