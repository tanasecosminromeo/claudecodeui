import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * A pin (or a title) change is broadcast as a `session_upserted` marked
 * `metadataOnly`. It must update the row without treating it as new
 * transcript activity: no attention dot on another row, no chat reload for
 * the row being viewed.
 */

const projectsResponse = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    projects: () => projectsResponse(),
    projectTaskmaster: () => Promise.resolve({ ok: false }),
    sessionDetails: () => Promise.resolve({ ok: false }),
    projectSessions: () => Promise.resolve({ ok: false }),
  },
}));

type ServerEventListener = (event: Record<string, unknown>) => void;
const listeners = new Set<ServerEventListener>();
const emit = (event: Record<string, unknown>) => {
  for (const listener of listeners) {
    listener(event);
  }
};

const buildProject = (sessions: ProjectSession[]): Project => ({
  projectId: 'project-1',
  path: '/repo',
  fullPath: '/repo',
  displayName: 'Repo',
  isStarred: false,
  sessions,
  sessionMeta: { hasMore: false, total: sessions.length },
});

const buildUpsert = (sessionId: string, metadataOnly: boolean) => ({
  kind: 'session_upserted',
  sessionId,
  providerSessionId: null,
  provider: 'claude',
  session: {
    id: sessionId,
    summary: `title ${sessionId}`,
    messageCount: 0,
    lastActivity: '2026-01-01T00:00:00.000Z',
    pinned: true,
  },
  project: {
    projectId: 'project-1',
    path: '/repo',
    fullPath: '/repo',
    displayName: 'Repo',
    isStarred: false,
  },
  ...(metadataOnly ? { metadataOnly: true } : {}),
  timestamp: '2026-01-01T00:00:00.000Z',
});

const renderProjectsState = async () => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
  return renderHook(() =>
    useProjectsState({
      sessionId: 'viewed',
      navigate: vi.fn() as never,
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
  projectsResponse.mockResolvedValue({
    ok: true,
    json: async () => [buildProject([
      { id: 'viewed', summary: 'viewed' } as ProjectSession,
      { id: 'other', summary: 'other' } as ProjectSession,
    ])],
  });
  listeners.clear();
});

afterEach(() => {
  vi.resetModules();
});

test('a metadata-only upsert updates the row without flagging it or reloading the chat', async () => {
  const { result } = await renderProjectsState();
  await waitFor(() => {
    expect(result.current.projects[0]?.sessions?.length).toBe(2);
  });
  act(() => {
    result.current.handleSessionSelect({ id: 'viewed' } as ProjectSession);
  });
  const reloadsBefore = result.current.externalMessageUpdate;

  await act(async () => {
    emit(buildUpsert('other', true));
    emit(buildUpsert('viewed', true));
  });

  const other = result.current.projects[0]?.sessions?.find((session) => session.id === 'other');
  expect(other?.pinned).toBe(true);
  expect(result.current.sidebarSharedProps.attentionSessionIds.has('other')).toBe(false);
  expect(result.current.externalMessageUpdate).toBe(reloadsBefore);
});

test('a transcript upsert still flags another row and reloads the viewed chat', async () => {
  const { result } = await renderProjectsState();
  await waitFor(() => {
    expect(result.current.projects[0]?.sessions?.length).toBe(2);
  });
  act(() => {
    result.current.handleSessionSelect({ id: 'viewed' } as ProjectSession);
  });
  const reloadsBefore = result.current.externalMessageUpdate;

  await act(async () => {
    emit(buildUpsert('other', false));
    emit(buildUpsert('viewed', false));
  });

  expect(result.current.sidebarSharedProps.attentionSessionIds.has('other')).toBe(true);
  expect(result.current.externalMessageUpdate).toBe(reloadsBefore + 1);
});
