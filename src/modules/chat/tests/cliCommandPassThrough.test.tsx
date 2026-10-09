import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import type { PermissionMode, Project, ProjectSession, SlashCommand } from '@/shared/types';

/**
 * The Claude CLI runs its own slash commands (`/compact`, `/context`, ...)
 * when they arrive as the message text. The composer lists them in its menu
 * but must never answer them itself: the text, arguments included, goes to the
 * session as typed. Picking one in the menu puts it in the composer, so
 * instructions can follow it, like a skill.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let executeCalls = 0;

beforeEach(() => {
  executeCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/commands/list')) {
      return json({
        builtIn: [{ name: '/help', description: 'Show help', namespace: 'builtin', metadata: { type: 'builtin' } }],
        custom: [],
        cli: [{ name: '/compact', description: 'Summarize', namespace: 'cli', metadata: { type: 'cli' } }],
      });
    }
    if (url.includes('/api/commands/execute')) {
      executeCalls += 1;
      return json({ type: 'builtin', action: 'help', data: {} });
    }
    return json([]);
  }));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderComposer = (sent: Array<Record<string, unknown>>, isLoading = false) => renderHook(() =>
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
    canAbortSession: isLoading,
    tokenBudget: null,
    sendMessage: (message) => { sent.push(message as Record<string, unknown>); },
    scrollToBottom: () => undefined,
    addMessage: () => undefined,
    setIsUserScrolledUp: () => undefined,
    setPendingPermissionRequests: () => undefined,
  }),
);

test('a CLI command is sent to the session as typed, arguments included, never executed here', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);
  await waitFor(() => assert.ok(view.result.current.slashCommandsCount > 1));

  await act(async () => { view.result.current.setInput('/compact focus on the parser'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  assert.equal(executeCalls, 0, 'the command API is not asked');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.type, 'chat.send');
  assert.equal(sent[0]?.content, '/compact focus on the parser');
  assert.equal(view.result.current.input, '');
});

test('a CLI command sent while a turn runs goes to the session at once, like any message', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent, true);
  await waitFor(() => assert.ok(view.result.current.slashCommandsCount > 1));

  await act(async () => { view.result.current.setInput('/compact'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  // The server keeps the turn open until the CLI has run it after the turn.
  assert.equal(executeCalls, 0);
  assert.equal(view.result.current.queuedDraft, null, 'not held back in the composer');
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.content, '/compact');
});

test('picking a CLI command in the menu puts it in the composer instead of running it', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const view = renderComposer(sent);
  await waitFor(() => assert.ok(view.result.current.slashCommandsCount > 1));

  const compact = view.result.current.filteredCommands.find((command: SlashCommand) => command.name === '/compact')
    ?? { name: '/compact', namespace: 'cli', type: 'cli', metadata: { type: 'cli' } };
  await act(async () => { view.result.current.handleCommandSelect(compact, 0, false); });

  assert.equal(view.result.current.input, '/compact ');
  assert.equal(executeCalls, 0);
  assert.equal(sent.length, 0);
});
