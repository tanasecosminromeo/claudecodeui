import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project, ProjectGroup } from '@/shared/types';
import { buildProjectSections, sortProjects } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import { getStarColor, nextStarColor } from '@/modules/sidebar/utils/starColors';

const project = (projectId: string, extra: Partial<Project> = {}): Project => ({
  projectId,
  displayName: projectId,
  fullPath: `/work/${projectId}`,
  ...extra,
});

const names = (projects: Project[]) => projects.map((entry) => entry.projectId);

test('star colors cycle like Gmail and end unstarred', () => {
  const seen: Array<string | null> = [];
  let color = nextStarColor(null);
  while (color !== null) {
    seen.push(color);
    color = nextStarColor(color);
  }
  assert.deepEqual(seen, ['yellow', 'orange', 'red', 'green', 'blue', 'purple']);
});

test('a project starred by an older server reads as yellow', () => {
  assert.equal(getStarColor({ isStarred: true }), 'yellow');
  assert.equal(getStarColor({ isStarred: true, starColor: null }), null);
  assert.equal(getStarColor({ isStarred: false, starColor: 'blue' }), 'blue');
});

test('sortProjects puts starred first, ranked by color, then by name', () => {
  const sorted = sortProjects(
    [
      project('zeta'),
      project('alpha'),
      project('blue-one', { isStarred: true, starColor: 'blue' }),
      project('yellow-b', { isStarred: true, starColor: 'yellow' }),
      project('red-one', { isStarred: true, starColor: 'red' }),
      project('yellow-a', { isStarred: true, starColor: 'yellow' }),
    ],
    'name',
  );

  assert.deepEqual(names(sorted), ['yellow-a', 'yellow-b', 'red-one', 'blue-one', 'alpha', 'zeta']);
});

test('buildProjectSections puts groups first by name, keeps order inside, then ungrouped', () => {
  const groups: ProjectGroup[] = [
    { groupId: 'g-client-b', name: 'client-b' },
    { groupId: 'g-client-a', name: 'client-a' },
    { groupId: 'g-empty', name: 'Empty' },
  ];
  const sorted = [
    project('client-b-site', { groupId: 'g-client-b', starColor: 'yellow' }),
    project('client-a-api', { groupId: 'g-client-a' }),
    project('homelab'),
    project('client-a-plugin', { groupId: 'g-client-a' }),
    project('orphan', { groupId: 'deleted-group' }),
  ];

  const sections = buildProjectSections(sorted, groups);

  assert.deepEqual(
    sections.map((section) => [section.group?.name ?? null, names(section.projects)]),
    [
      ['client-a', ['client-a-api', 'client-a-plugin']],
      ['client-b', ['client-b-site']],
      [null, ['homelab', 'orphan']],
    ],
  );
});

test('buildProjectSections with no groups is one ungrouped section', () => {
  const sections = buildProjectSections([project('a'), project('b')], []);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].group, null);
});
