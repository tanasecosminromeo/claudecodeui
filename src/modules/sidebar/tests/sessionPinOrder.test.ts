import { expect, test } from 'vitest';

import type { Project } from '@/shared/types';
import { getAllSessions } from '@/modules/sidebar/utils/sidebarProjectFormatting';

const project = (sessions: Array<Record<string, unknown>>) => ({
  projectId: 'project-1',
  sessions,
}) as unknown as Project;

test('pinned sessions come first, and each group stays newest first', () => {
  const sessions = getAllSessions(project([
    { id: 'middle', summary: 'middle', lastActivity: '2026-08-20T10:00:00.000Z', provider: 'claude' },
    { id: 'pinned-old', summary: 'pinned old', lastActivity: '2026-08-01T10:00:00.000Z', provider: 'claude', pinned: true },
    { id: 'newest', summary: 'newest', lastActivity: '2026-08-21T10:00:00.000Z', provider: 'codex' },
    { id: 'pinned-new', summary: 'pinned new', lastActivity: '2026-08-15T10:00:00.000Z', provider: 'codex', pinned: true },
    { id: 'oldest', summary: 'oldest', lastActivity: '2026-07-01T10:00:00.000Z', provider: 'claude', pinned: false },
  ]));

  expect(sessions.map((session) => session.id)).toEqual([
    'pinned-new',
    'pinned-old',
    'newest',
    'middle',
    'oldest',
  ]);
});

test('unpinning a session returns it to its activity position', () => {
  const sessions = getAllSessions(project([
    { id: 'was-pinned', summary: 'was pinned', lastActivity: '2026-08-01T10:00:00.000Z', provider: 'claude', pinned: false },
    { id: 'recent', summary: 'recent', lastActivity: '2026-08-21T10:00:00.000Z', provider: 'claude' },
  ]));

  expect(sessions.map((session) => session.id)).toEqual(['recent', 'was-pinned']);
});
