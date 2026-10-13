import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project, ProjectSession, StarColor } from '@/shared/types';
import { sortProjects } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { parseProjectSortOrder } from '@/shared/userSettings';

const project = (projectId: string, extra: Partial<Project> = {}): Project => ({
  projectId,
  displayName: projectId,
  fullPath: `/work/${projectId}`,
  ...extra,
});

const names = (projects: Project[]) => projects.map((entry) => entry.projectId);

const dated = (projectId: string, lastActivity: string, extra: Partial<Project> = {}): Project =>
  project(projectId, { sessions: [{ id: projectId, lastActivity } as ProjectSession], ...extra });

test('starred mode lists every starred project before unstarred ones, ignoring colour', () => {
  const sorted = sortProjects(
    [
      project('delta'),
      project('red-one', { isStarred: true, starColor: 'red' }),
      project('alpha'),
      project('green-one', { isStarred: true, starColor: 'green' }),
      project('charlie', { isStarred: true, starColor: 'orange' }),
      project('bravo', { isStarred: true, starColor: 'yellow' }),
    ],
    'starred',
  );

  assert.deepEqual(names(sorted), ['bravo', 'charlie', 'green-one', 'red-one', 'alpha', 'delta']);
});

test('starred mode sorts each block alphabetically, not by colour', () => {
  const sorted = sortProjects(
    [
      project('zeta', { isStarred: true, starColor: 'green' }),
      project('alpha', { isStarred: true, starColor: 'red' }),
    ],
    'starred',
  );

  assert.deepEqual(names(sorted), ['alpha', 'zeta']);
});

test('recolouring starred projects leaves the starred order identical', () => {
  const before = [
    project('alpha'),
    project('beta', { isStarred: true, starColor: 'yellow' }),
    project('gamma', { isStarred: true, starColor: 'green' }),
  ];
  const recoloured = [
    project('alpha'),
    project('beta', { isStarred: true, starColor: 'red' }),
    project('gamma', { isStarred: true, starColor: 'orange' }),
  ];

  assert.deepEqual(names(sortProjects(recoloured, 'starred')), names(sortProjects(before, 'starred')));
  assert.deepEqual(names(sortProjects(before, 'starred')), ['beta', 'gamma', 'alpha']);
});

test('name mode stays alphabetical and does not pull starred projects up', () => {
  const sorted = sortProjects(
    [
      project('zeta', { isStarred: true, starColor: 'red' }),
      project('alpha'),
      project('mid', { isStarred: true, starColor: 'green' }),
    ],
    'name',
  );

  assert.deepEqual(names(sorted), ['alpha', 'mid', 'zeta']);
});

test('date mode stays by most recent activity and does not pull starred projects up', () => {
  const sorted = sortProjects(
    [
      dated('old', '2026-01-01T00:00:00Z', { isStarred: true, starColor: 'red' }),
      dated('new', '2026-03-01T00:00:00Z'),
      dated('mid', '2026-02-01T00:00:00Z', { isStarred: true, starColor: 'green' }),
    ],
    'date',
  );

  assert.deepEqual(names(sorted), ['new', 'mid', 'old']);
});

test('parseProjectSortOrder keeps the three valid orders', () => {
  assert.equal(parseProjectSortOrder('starred'), 'starred');
  assert.equal(parseProjectSortOrder('name'), 'name');
  assert.equal(parseProjectSortOrder('date'), 'date');
});

test('parseProjectSortOrder falls back to starred for missing or unknown values', () => {
  assert.equal(parseProjectSortOrder(undefined), 'starred');
  assert.equal(parseProjectSortOrder(null), 'starred');
  assert.equal(parseProjectSortOrder(''), 'starred');
  assert.equal(parseProjectSortOrder('alphabetical'), 'starred');
  assert.equal(parseProjectSortOrder(['name']), 'starred');
  assert.equal(parseProjectSortOrder('red' as StarColor), 'starred');
});
