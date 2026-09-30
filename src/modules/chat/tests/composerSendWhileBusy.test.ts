import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { LLMProvider, PermissionMode, Project, ProjectSession } from '@/shared/types';

/**
 * Sending never waits on, or stops, what the session is doing — the way
 * typing while Claude works does in the CLI. A Claude session takes the
 * message straight into its live process, mid-turn or while background work
 * runs; stopping work is the Stop button's job, never a side effect of
 * sending. A provider that runs one process per turn still queues the message
 * until the turn ends.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const submit = async ({ provider, isLoading }: { provider: LLMProvider; isLoading: boolean }) => {
  const sent: Array<{ type: string; content?: string }> = [];
  const view = renderHook(() =>
    useChatComposerState({
      selectedProject: PROJECT,
      selectedSession: SESSION,
      currentSessionId: SESSION.id,
      provider,
      permissionMode: 'default',
      cyclePermissionMode: () => undefined,
      resolvePermissionModeForProvider: () => 'default' as PermissionMode,
      currentProviderModel: 'test-model',
      currentProviderEffort: 'medium',
      isLoading,
      canAbortSession: isLoading,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string; content?: string }); },
      scrollToBottom: () => undefined,
      addMessage: () => undefined,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );
  await act(async () => { view.result.current.setInput('hello'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });
  return { sends: sent.filter((message) => message.type === 'chat.send'), view };
};

const confirm = vi.fn<(message?: string) => boolean>();

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('confirm', confirm);
  confirm.mockReset();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('a Claude session between turns sends without asking, background work or not', async () => {
  const { sends } = await submit({ provider: 'claude', isLoading: false });

  assert.equal(confirm.mock.calls.length, 0);
  assert.equal(sends.length, 1);
});

test('a Claude session mid-turn sends the message into the running turn', async () => {
  const { sends, view } = await submit({ provider: 'claude', isLoading: true });

  assert.equal(confirm.mock.calls.length, 0);
  assert.deepEqual(sends.map((message) => message.content), ['hello']);
  assert.equal(view.result.current.queuedDraft, null, 'nothing is held back in the composer');
  assert.equal(view.result.current.input, '');
});

test('a provider that runs one process per turn still queues mid-turn', async () => {
  const { sends, view } = await submit({ provider: 'codex', isLoading: true });

  assert.equal(sends.length, 0);
  assert.equal(view.result.current.queuedDraft?.content, 'hello');
});
