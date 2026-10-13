import assert from 'node:assert/strict';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, ProjectSession } from '@/shared/types';

/**
 * An automatic rename or status change lands on the same two copies a manual
 * rename patches: the sidebar row and the workspace header's selectedSession.
 * It must not refetch the project list to get there.
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

const session: ProjectSession = { id: 'session-1', summary: 'Original title', __provider: 'claude' };
const otherSession: ProjectSession = { id: 'session-2', summary: 'Untouched', __provider: 'claude' };

const buildProject = (): Project => ({
  projectId: 'project-1',
  path: '/workspace/client-a',
  fullPath: '/workspace/client-a',
  displayName: 'client-a',
  isStarred: false,
  sessions: [session, otherSession],
  sessionMeta: { hasMore: false, total: 2 },
});

const renderProjectsState = async () => {
  const { useProjectsState } = await import('@/modules/project-workspace/hooks/useProjectsState');

  return renderHook(() =>
    useProjectsState({
      sessionId: undefined,
      navigate: vi.fn(),
      subscribe: () => () => {},
      isMobile: false,
      isSessionProcessing: () => false,
    }),
  );
};

beforeEach(() => {
  localStorage.clear();
  projectsResponse.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

test('an automatic rename and status update the sidebar row and the selected session in place', async () => {
  projectsResponse.mockResolvedValue({ ok: true, json: async () => [buildProject()] });
  const { result } = await renderProjectsState();
  await waitFor(() => {
    assert.equal(result.current.projects.length, 1);
  });
  act(() => {
    result.current.handleSessionSelect({ ...session, __projectId: 'project-1' });
  });
  const untouchedRowBefore = result.current.projects[0].sessions?.[1];

  act(() => {
    result.current.sidebarSharedProps.onSessionUpdated('session-1', {
      summary: 'Fix login test',
      status: 'bug',
      statusSource: 'auto',
      nameSource: 'auto',
    });
  });

  assert.equal(result.current.selectedSession?.summary, 'Fix login test');
  assert.equal(result.current.selectedSession?.status, 'bug');
  assert.equal(result.current.selectedSession?.statusSource, 'auto');
  assert.equal(result.current.selectedSession?.nameSource, 'auto');
  const rows = result.current.projects[0].sessions ?? [];
  assert.equal(rows[0].summary, 'Fix login test');
  assert.equal(rows[0].status, 'bug');
  assert.equal(rows[1], untouchedRowBefore, 'rows the patch does not touch keep their identity');
  assert.equal(projectsResponse.mock.calls.length, 1, 'no refetch of the project list');
});
