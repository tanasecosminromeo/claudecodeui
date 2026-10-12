import assert from 'node:assert/strict';
import test from 'node:test';

import { PROTECTED_CONTENT_NOTICE, maskNormalizedMessage, maskNormalizedMessages } from '@/shared/message-masking.js';
import type { NormalizedMessage } from '@/shared/types.js';

const HOME = '/users/someone';
const PROJECT = '/srv/project';
const FAKE_SECRET = 'FAKE_TEST_VALUE_not_a_real_key';
const FAKE_GITHUB_TOKEN = 'gh' + 'p_' + 'A'.repeat(36);

function message(fields: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    timestamp: '2026-10-12T10:00:00.000Z',
    provider: 'claude',
    kind: 'tool_use',
    ...fields,
  } as NormalizedMessage;
}

test('reading a .env file keeps the path and hides the contents', () => {
  const input = message({
    toolName: 'Read',
    toolId: 't1',
    toolInput: { file_path: `${PROJECT}/.env` },
    toolResult: { content: `API_KEY=${FAKE_SECRET}`, isError: false },
  });
  const masked = maskNormalizedMessage(input, HOME);
  assert.equal(masked.toolName, 'Read');
  assert.deepEqual(masked.toolInput, { file_path: `${PROJECT}/.env` });
  assert.equal(masked.toolResult?.content, PROTECTED_CONTENT_NOTICE);
  assert.equal(masked.toolResult?.isError, false);
});

test('cat of an SSH private key through Bash hides the output and keeps the command', () => {
  const input = message({
    toolName: 'Bash',
    toolInput: { command: 'cat ~/.ssh/id_ed25519' },
    toolResult: { content: 'FAKE KEY BODY LINE' },
  });
  const masked = maskNormalizedMessage(input, HOME);
  assert.deepEqual(masked.toolInput, { command: 'cat ~/.ssh/id_ed25519' });
  assert.equal(masked.toolResult?.content, PROTECTED_CONTENT_NOTICE);
});

test('editing an env file hides the old and new strings but keeps the path', () => {
  const input = message({
    toolName: 'Edit',
    toolInput: { file_path: `${PROJECT}/.env.local`, old_string: 'A=1', new_string: `B=${FAKE_SECRET}` },
  });
  const masked = maskNormalizedMessage(input, HOME);
  assert.deepEqual(masked.toolInput, {
    file_path: `${PROJECT}/.env.local`,
    old_string: PROTECTED_CONTENT_NOTICE,
    new_string: PROTECTED_CONTENT_NOTICE,
  });
});

test('a readable file with a key-like line only has the value masked', () => {
  const input = message({
    toolName: 'Read',
    toolInput: { file_path: `${PROJECT}/src/app.ts` },
    toolResult: { content: `const port = 3001;\nAPI_KEY=${FAKE_SECRET}\n` },
  });
  const masked = maskNormalizedMessage(input, HOME);
  assert.deepEqual(masked.toolInput, { file_path: `${PROJECT}/src/app.ts` });
  assert.equal(masked.toolResult?.content, 'const port = 3001;\nAPI_KEY=••••\n');
});

test('assistant text with a token has the token masked', () => {
  const input = message({
    kind: 'text',
    role: 'assistant',
    content: `Use this token: ${FAKE_GITHUB_TOKEN} for the clone.`,
    text: `Use this token: ${FAKE_GITHUB_TOKEN} for the clone.`,
  });
  const masked = maskNormalizedMessage(input, HOME);
  assert.equal(masked.content, 'Use this token: •••• for the clone.');
  assert.equal(masked.text, 'Use this token: •••• for the clone.');
});

test('a message with nothing secret comes back deep-equal to the input', () => {
  const input = message({
    toolName: 'Read',
    toolInput: { file_path: `${PROJECT}/src/app.ts`, offset: 1 },
    toolResult: { content: 'export const answer = 42;', isError: false, toolUseResult: { lines: 1 } },
  });
  assert.deepEqual(maskNormalizedMessage(input, HOME), input);
});

test('the input message is never mutated', () => {
  const input = message({
    toolName: 'Edit',
    toolInput: { file_path: `${PROJECT}/.env`, new_string: `KEY=${FAKE_SECRET}` },
    toolResult: { content: 'ok' },
  });
  const snapshot = structuredClone(input);
  maskNormalizedMessage(input, HOME);
  assert.deepEqual(input, snapshot);
});

test('a tool result row is hidden through the call it answers, and the count is unchanged', () => {
  const messages: NormalizedMessage[] = [
    message({ id: 'a', toolName: 'Read', toolId: 'call-1', toolInput: { file_path: `${PROJECT}/.env` } }),
    message({ id: 'b', kind: 'tool_result', toolId: 'call-1', content: `API_KEY=${FAKE_SECRET}` }),
    message({ id: 'c', kind: 'tool_result', toolId: 'call-2', content: `plain ${FAKE_GITHUB_TOKEN}` }),
  ];
  const masked = maskNormalizedMessages(messages, HOME);
  assert.equal(masked.length, 3);
  assert.equal(masked[1].content, PROTECTED_CONTENT_NOTICE);
  assert.equal(masked[2].content, 'plain ••••');
  assert.deepEqual(masked[0].toolInput, { file_path: `${PROJECT}/.env` });
});
