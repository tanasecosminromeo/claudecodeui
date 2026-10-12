import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { Project, ServerEvent } from '@/shared/types';

/**
 * `side_question_updated` carries a sessionId, and the projects state treats any
 * kind with a sessionId as attention activity. It must skip this kind, while an
 * unrelated kind still marks the session, which proves the harness reaches the
 * listener at all.
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

const sideQuestionEvent: ServerEvent = {
  kind: 'side_question_updated',
  sessionId: 'other-session',
  entry: {
    id: 1,
    sessionId: 'other-session',
    question: 'q',
    answer: null,
    status: 'pending',
    source: null,
    error: null,
    createdAt: '2026-10-12T07:00:00.000Z',
    answeredAt: null,
    saved: true,
  },
};
describe('projects state', () => {
  type ServerEventListener = (event: ServerEvent) => void;
  const listeners = new Set<ServerEventListener>();

  const renderProjectsState = async () => {
    const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');
    return renderHook(() => useProjectsState({
      sessionId: undefined,
      navigate: vi.fn(),
      subscribe: (listener: ServerEventListener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      isMobile: false,
      isSessionProcessing: () => false,
    }));
  };

  const emit = (event: ServerEvent) => {
    act(() => {
      for (const listener of listeners) {
        listener(event);
      }
    });
  };

  beforeEach(() => {
    localStorage.clear();
    listeners.clear();
    projectsResponse.mockReset();
    const projects: Project[] = [{
      projectId: 'project-1',
      path: '/repo',
      fullPath: '/repo',
      displayName: 'Repo',
      isStarred: false,
      sessions: [],
      sessionMeta: { hasMore: false, total: 0 },
    }];
    projectsResponse.mockResolvedValue({ ok: true, json: async () => projects });
  });

  afterEach(() => {
    vi.resetModules();
  });

  test('side_question_updated does not mark the other session as needing attention', async () => {
    const { result } = await renderProjectsState();
    await waitFor(() => {
      expect(result.current.projects.length).toBe(1);
    });

    emit(sideQuestionEvent);

    expect(result.current.sidebarSharedProps.attentionSessionIds.has('other-session')).toBe(false);
  });

  test('control: an unrelated kind for the same session marks it as needing attention', async () => {
    const { result } = await renderProjectsState();
    await waitFor(() => {
      expect(result.current.projects.length).toBe(1);
    });

    emit({ kind: 'unrelated_probe', sessionId: 'other-session' });

    expect(result.current.sidebarSharedProps.attentionSessionIds.has('other-session')).toBe(true);
  });
});
