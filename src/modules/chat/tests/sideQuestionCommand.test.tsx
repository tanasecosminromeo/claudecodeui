import assert from 'node:assert/strict';

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import { useChatComposerState } from '@/modules/chat/hooks/useChatComposerState';
import CommandResultModal from '@/modules/chat/modals/CommandResultModal';
import type { PermissionMode, Project, ProjectSession, ProviderModelActions, SideQuestionCommandData } from '@/shared/types';

/**
 * `/btw` asks a side question about the session while its turn keeps running.
 * Every other submit made while the session is busy is queued behind the
 * turn; this one must go out immediately and land in the command modal, never
 * in the conversation.
 */

const PROJECT: Project = { projectId: 'project-1', displayName: 'Project One', fullPath: '/tmp/project-one' };
const SESSION: ProjectSession = { id: 'session-1' };

const BUILT_IN_COMMANDS = [
  { name: '/btw', description: 'Ask a side question', namespace: 'builtin', metadata: { type: 'builtin' } },
];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let executeBodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  executeBodies = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/commands/list')) {
      return json({ builtIn: BUILT_IN_COMMANDS, custom: [] });
    }
    if (url.includes('/api/commands/execute')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      executeBodies.push(body);
      return json({
        type: 'builtin',
        action: 'btw',
        command: '/btw',
        data: { question: 'what are you doing?', status: 'answered', answer: 'Refactoring **the parser**.', source: 'live' },
      });
    }
    return json([]);
  }));
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

test('/btw while a turn is running is executed right away instead of being queued', async () => {
  const sent: Array<{ type: string }> = [];
  const addMessage = vi.fn();
  const view = renderHook(() =>
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
      isLoading: true,
      canAbortSession: true,
      tokenBudget: null,
      sendMessage: (message) => { sent.push(message as { type: string }); },
      scrollToBottom: () => undefined,
      addMessage,
      setIsUserScrolledUp: () => undefined,
      setPendingPermissionRequests: () => undefined,
    }),
  );
  // The command list loads asynchronously; /btw is only recognised once it has.
  await waitFor(() => assert.ok(view.result.current.slashCommandsCount > 0));

  await act(async () => { view.result.current.setInput('/btw what are you doing?'); });
  await act(async () => { await view.result.current.handleSubmit({ preventDefault: () => undefined } as never); });

  const sideQuestionStatus = () => (view.result.current.commandModalPayload?.data as SideQuestionCommandData | undefined)?.status;
  await waitFor(() => assert.equal(sideQuestionStatus(), 'answered'));
  assert.equal(executeBodies.length, 1);
  assert.equal(executeBodies[0]?.commandName, '/btw');
  assert.deepEqual(executeBodies[0]?.args, ['what', 'are', 'you', 'doing?']);
  assert.equal((executeBodies[0]?.context as { sessionId?: string } | undefined)?.sessionId, 'session-1');
  assert.equal(view.result.current.queuedDraft, null, 'nothing waits behind the running turn');
  assert.equal(sent.length, 0, 'nothing is sent into the session');
  assert.equal(addMessage.mock.calls.length, 0, 'nothing is added to the transcript');
  assert.equal(view.result.current.commandModalPayload?.kind, 'btw');
  assert.equal(view.result.current.input, '');
});

const renderModal = (data: Record<string, unknown>) => render(
  <CommandResultModal
    payload={{ kind: 'btw', data: data as never }}
    onClose={() => undefined}
    providerModelCatalog={{}}
    providerModelActions={{} as ProviderModelActions}
    activeProvider="claude"
    activeProviderModel="test-model"
    currentSessionId="session-1"
    onSelectProviderModel={async () => ({ scope: 'session', model: 'test-model' })}
  />,
);

test('the modal renders a side-question answer as markdown with a markdown copy control', () => {
  renderModal({ question: 'what are you doing?', status: 'answered', answer: 'Refactoring **the parser**.' });

  assert.equal(screen.getByText('the parser').tagName, 'STRONG');
  assert.ok(screen.getByText('what are you doing?'));
  assert.ok(screen.getByText('MD'), 'copies as markdown by default');
});

test('the modal shows a pending side question and translated non-answers', () => {
  const pending = renderModal({ question: 'q', status: 'pending' });
  assert.ok(screen.getByRole('status'));
  pending.unmount();

  renderModal({ question: 'q', status: 'unsupported', message: 'server text' });
  assert.ok(screen.getByText('/btw is only available in Claude sessions.'));
});
