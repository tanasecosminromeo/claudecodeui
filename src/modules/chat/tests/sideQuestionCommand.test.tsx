import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession } from '@/shared/types';
import {
  resetSideQuestionsStore,
  useSideQuestionEntries,
  useSideQuestionsPanelOpen,
} from '@/modules/side-questions';

/**
 * `/btw` asks a side question about the session while its turn keeps running.
 * Every other submit made while the session is busy is queued behind the
 * turn; this one must go out immediately and land in the side-questions panel
 * as a pending entry, opening the panel if it is closed. It never opens the
 * command modal and never enters the conversation.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const BUILT_IN_COMMANDS = [
  { name: '/btw', description: 'Ask a side question', namespace: 'builtin', metadata: { type: 'builtin' } },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const pendingEntry = {
  id: 7,
  sessionId: 'session-1',
  question: 'what are you doing?',
  answer: null,
  status: 'pending',
  source: null,
  error: null,
  createdAt: '2026-10-12T07:00:00.000Z',
  answeredAt: null,
  saved: true,
};

let executeBodies: Array<Record<string, unknown>> = [];
let executeResult: Record<string, unknown>;

beforeEach(() => {
  executeBodies = [];
  executeResult = {
    type: 'builtin',
    action: 'btw',
    command: '/btw',
    data: { question: 'what are you doing?', entry: pendingEntry },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/commands/list')) {
      return json({ builtIn: BUILT_IN_COMMANDS, custom: [] });
    }
    if (url.includes('/api/commands/execute')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      executeBodies.push(body);
      return json(executeResult);
    }
    return json([]);
  }));
  localStorage.clear();
  resetSideQuestionsStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  resetSideQuestionsStore();
});

const renderComposer = (addMessage = vi.fn(), isLoading = true) => renderHook(() =>
  useChatComposerState({
    selectedProject: PROJECT,
    selectedSession: SESSION,
    currentSessionId: SESSION.id,
    provider: 'claude',
    permissionMode: 'default',
    cyclePermissionMode: () => undefined,
    resolvePermissionModeForProvider: () => 'default' as PermissionMode,
    currentProviderModel: 'test-model',
    currentProviderEffort: 'medium',
    isLoading,
    canAbortSession: true,
    tokenBudget: null,
    sendMessage: () => undefined,
    scrollToBottom: () => undefined,
    addMessage,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }),
);

test('/btw while a turn is running goes out at once, shows a pending entry and opens the panel without a modal', async () => {
  const addMessage = vi.fn();
  const view = renderComposer(addMessage);
  const entries = renderHook(() => useSideQuestionEntries('session-1'));
  const panelOpen = renderHook(() => useSideQuestionsPanelOpen());
  expect(panelOpen.result.current).toBe(false);

  // The command list loads asynchronously; /btw is only recognised once it has.
  await waitFor(() => {
    expect(view.result.current.slashCommandsCount).toBeGreaterThan(0);
  });

  await act(async () => { view.result.current.setInput('/btw what are you doing?'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  await waitFor(() => {
    expect(entries.result.current[0]?.status).toBe('pending');
  });
  expect(executeBodies.length).toBe(1);
  expect(executeBodies[0]?.commandName).toBe('/btw');
  expect(executeBodies[0]?.args).toEqual(['what', 'are', 'you', 'doing?']);
  expect((executeBodies[0]?.context as { sessionId?: string } | undefined)?.sessionId).toBe('session-1');
  expect(entries.result.current[0]?.id).toBe(7);
  expect(panelOpen.result.current).toBe(true);
  expect(view.result.current.commandModalPayload).toBeNull();
  expect(view.result.current.queuedDraft).toBeNull();
  expect(addMessage).not.toHaveBeenCalled();
  expect(view.result.current.input).toBe('');
});

test('a /btw that was not asked shows its message inline in the chat', async () => {
  executeResult = {
    type: 'builtin',
    action: 'btw',
    command: '/btw',
    data: {
      question: 'what are you doing?',
      status: 'no_context',
      message: 'This session has no conversation yet. Send a message first, then ask /btw.',
    },
  };
  const addMessage = vi.fn();
  const view = renderComposer(addMessage, false);
  const entries = renderHook(() => useSideQuestionEntries('session-1'));

  await waitFor(() => {
    expect(view.result.current.slashCommandsCount).toBeGreaterThan(0);
  });
  await act(async () => { view.result.current.setInput('/btw what are you doing?'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  await waitFor(() => {
    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'assistant',
      content: 'This session has no conversation yet. Send a message first, then ask /btw.',
    }));
  });
  expect(entries.result.current).toEqual([]);
  expect(view.result.current.commandModalPayload).toBeNull();
});
