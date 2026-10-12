import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import '@/modules/i18n';
import type { Project, ProjectSession, SideQuestionEntry } from '@/shared/types';

/**
 * The side-questions panel: entries render by status, a websocket update
 * replaces a pending entry, Retry asks the same question again, and Start
 * session seeds the project's new-chat draft (keeping existing text below)
 * before opening a new chat. The API, the websocket and the drafts are mocked.
 */

const mocks = vi.hoisted(() => ({
  sideQuestions: vi.fn(),
  execute: vi.fn(),
  listeners: new Set<(event: { kind: string; [key: string]: unknown }) => void>(),
  drafts: new Map<string, string>(),
}));

vi.mock('@/shared/api', () => ({
  api: {
    commands: {
      sideQuestions: (sessionId: string) => mocks.sideQuestions(sessionId),
      execute: (payload: unknown) => mocks.execute(payload),
    },
  },
}));

vi.mock('@/shared/context/WebSocketContext', () => ({
  useWebSocket: () => ({
    subscribe: (listener: (event: { kind: string; [key: string]: unknown }) => void) => {
      mocks.listeners.add(listener);
      return () => mocks.listeners.delete(listener);
    },
    connectionStatus: 'connected',
  }),
}));

vi.mock('@/shared/chatDrafts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readDraftText: (scope: string) => mocks.drafts.get(scope) ?? '',
  writeDraftText: (scope: string, text: string) => {
    mocks.drafts.set(scope, text);
  },
}));

const { SideQuestionsPanel, resetSideQuestionsStore, setSideQuestionsPanelOpen } = await import('@/modules/side-questions');

const PROJECT: Project = { projectId: 'project-1', path: '/repo', fullPath: '/repo', displayName: 'Repo' };
const SESSION: ProjectSession = { id: 'session-1', summary: 'Original title', __provider: 'claude', __projectId: 'project-1' };
const TRANSCRIPT = '/var/lib/sessions/session-1.jsonl';

const entry = (overrides: Partial<SideQuestionEntry>): SideQuestionEntry => ({
  id: 1,
  sessionId: 'session-1',
  question: 'What changed?',
  answer: null,
  status: 'pending',
  source: null,
  error: null,
  createdAt: '2026-10-12T07:00:00.000Z',
  answeredAt: null,
  saved: true,
  ...overrides,
});

const jsonResponse = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const renderPanel = (onStartNewChat = vi.fn()) => render(
  <SideQuestionsPanel
    selectedProject={PROJECT}
    selectedSession={SESSION}
    activeTab="chat"
    isMobile={false}
    onStartNewChat={onStartNewChat}
  />,
);

const emit = (event: Record<string, unknown>) => {
  act(() => {
    for (const listener of mocks.listeners) {
      listener(event as { kind: string });
    }
  });
};

beforeEach(() => {
  localStorage.clear();
  resetSideQuestionsStore();
  setSideQuestionsPanelOpen(true);
  mocks.drafts.clear();
  mocks.listeners.clear();
  mocks.sideQuestions.mockReset();
  mocks.execute.mockReset();
});

afterEach(() => {
  localStorage.clear();
});

test('renders pending, answered, failed and unsaved entries', async () => {
  mocks.sideQuestions.mockResolvedValue(jsonResponse({
    entries: [
      entry({ id: 1, question: 'Still going?', status: 'pending' }),
      entry({ id: 2, question: 'How is the parser?', status: 'answered', answer: 'Refactoring **the parser**.', source: 'live', answeredAt: '2026-10-12T07:01:00.000Z' }),
      entry({ id: 3, question: 'Anything else?', status: 'failed', error: 'Provider unavailable', saved: false }),
    ],
    transcriptPath: TRANSCRIPT,
  }));

  renderPanel();

  expect(await screen.findByText('Answering...')).toBeTruthy();
  expect(screen.getByText('the parser').tagName).toBe('STRONG');
  expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Start session' })).toBeTruthy();
  expect(screen.getByText('Provider unavailable')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  expect(screen.getByText('Not saved.', { exact: false })).toBeTruthy();
  expect(mocks.sideQuestions).toHaveBeenCalledWith('session-1');
});

test('Retry asks the same question again as a new entry', async () => {
  mocks.sideQuestions.mockResolvedValue(jsonResponse({
    entries: [entry({ id: 3, status: 'failed', error: 'Provider unavailable' })],
    transcriptPath: null,
  }));
  mocks.execute.mockResolvedValue(jsonResponse({
    type: 'builtin',
    action: 'btw',
    data: { question: 'What changed?', entry: entry({ id: 4, status: 'pending' }) },
  }));

  renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));

  await waitFor(() => {
    expect(screen.getByText('Answering...')).toBeTruthy();
  });
  expect(mocks.execute).toHaveBeenCalledWith(expect.objectContaining({
    commandName: '/btw',
    args: ['What changed?'],
    context: expect.objectContaining({ sessionId: 'session-1', projectId: 'project-1' }),
  }));
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});

test('a websocket update replaces a pending entry', async () => {
  mocks.sideQuestions.mockResolvedValue(jsonResponse({
    entries: [entry({ id: 1, status: 'pending' })],
    transcriptPath: null,
  }));

  renderPanel();
  await screen.findByText('Answering...');

  emit({
    kind: 'side_question_updated',
    sessionId: 'session-1',
    entry: entry({ id: 1, status: 'answered', answer: 'Done.', source: 'live' }),
  });

  expect(await screen.findByText('Done.')).toBeTruthy();
  expect(screen.queryByText('Answering...')).toBeNull();
});

test('Start session seeds the new-chat draft with the transcript line and starts a new chat', async () => {
  mocks.sideQuestions.mockResolvedValue(jsonResponse({
    entries: [entry({ id: 2, status: 'answered', answer: 'Refactoring the parser.' })],
    transcriptPath: TRANSCRIPT,
  }));
  const onStartNewChat = vi.fn();

  renderPanel(onStartNewChat);
  fireEvent.click(await screen.findByRole('button', { name: 'Start session' }));

  expect(mocks.drafts.get('project:project-1')).toBe([
    'Started from a side question in session "Original title" (session-1).',
    `Its transcript is at ${TRANSCRIPT} — read it if you need more context.`,
    '',
    'Question: What changed?',
    '',
    'Answer:',
    'Refactoring the parser.',
  ].join('\n'));
  expect(onStartNewChat).toHaveBeenCalledWith(PROJECT);
});

test('Start session leaves out the transcript line when there is no transcript path and keeps the existing draft below', async () => {
  mocks.sideQuestions.mockResolvedValue(jsonResponse({
    entries: [entry({ id: 2, status: 'answered', answer: 'Refactoring the parser.' })],
    transcriptPath: null,
  }));
  mocks.drafts.set('project:project-1', 'half-typed note');
  const onStartNewChat = vi.fn();

  renderPanel(onStartNewChat);
  fireEvent.click(await screen.findByRole('button', { name: 'Start session' }));

  expect(mocks.drafts.get('project:project-1')).toBe([
    'Started from a side question in session "Original title" (session-1).',
    '',
    'Question: What changed?',
    '',
    'Answer:',
    'Refactoring the parser.',
    '',
    'half-typed note',
  ].join('\n'));
  expect(onStartNewChat).toHaveBeenCalledWith(PROJECT);
});

test('a new chat without a session explains that the first message comes first and cannot ask', async () => {
  render(
    <SideQuestionsPanel
      selectedProject={PROJECT}
      selectedSession={null}
      activeTab="chat"
      isMobile={false}
      onStartNewChat={vi.fn()}
    />,
  );

  expect(await screen.findByText('Send the first message in this chat before /btw works here.', { exact: false })).toBeTruthy();
  expect(mocks.sideQuestions).not.toHaveBeenCalled();
  expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
});
