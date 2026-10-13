import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project, ProjectGroup, ProjectSession, StarColor } from '@/shared/types';
import {
  buildProjectSections,
  filterStarredProjects,
  sortProjects,
} from '@/modules/sidebar/utils/sidebarProjectFormatting';
import {
  STAR_COLORS,
  STAR_CYCLE_WINDOW_MS,
  getStarColor,
  isStarColor,
  nextStarColor,
  nextStarFilter,
  starAfterClick,
} from '@/modules/sidebar/utils/starColors';

const project = (projectId: string, extra: Partial<Project> = {}): Project => ({
  projectId,
  displayName: projectId,
  fullPath: `/work/${projectId}`,
  ...extra,
});

const names = (projects: Project[]) => projects.map((entry) => entry.projectId);

/** A project whose only session was last active at `lastActivity`, for date sorting. */
const dated = (projectId: string, lastActivity: string, extra: Partial<Project> = {}): Project =>
  project(projectId, { sessions: [{ id: projectId, lastActivity } as ProjectSession], ...extra });

test('star colours are the four, in rising priority', () => {
  assert.deepEqual(STAR_COLORS, ['green', 'yellow', 'orange', 'red']);
});

test('star colours cycle up from green and end unstarred after red', () => {
  const seen: Array<string | null> = [];
  let color = nextStarColor(null);
  while (color !== null) {
    seen.push(color);
    color = nextStarColor(color);
  }
  assert.deepEqual(seen, ['green', 'yellow', 'orange', 'red']);
});

test('isStarColor accepts only the four current colours', () => {
  for (const color of ['green', 'yellow', 'orange', 'red']) {
    assert.equal(isStarColor(color), true);
  }
  assert.equal(isStarColor('blue'), false);
  assert.equal(isStarColor('purple'), false);
  assert.equal(isStarColor(null), false);
});

test('a project starred by an older server reads as yellow', () => {
  assert.equal(getStarColor({ isStarred: true }), 'yellow');
  assert.equal(getStarColor({ isStarred: true, starColor: null }), null);
});

test('retired blue and purple read as green', () => {
  assert.equal(getStarColor({ isStarred: true, starColor: 'blue' as StarColor }), 'green');
  assert.equal(getStarColor({ isStarred: true, starColor: 'purple' as StarColor }), 'green');
  assert.equal(getStarColor({ isStarred: false, starColor: 'red' }), 'red');
});

test('sortProjects orders by name and ignores star colour', () => {
  const sorted = sortProjects(
    [
      project('zeta', { isStarred: true, starColor: 'green' }),
      project('alpha'),
      project('mid', { isStarred: true, starColor: 'red' }),
      project('beta', { isStarred: true, starColor: 'yellow' }),
    ],
    'name',
  );

  assert.deepEqual(names(sorted), ['alpha', 'beta', 'mid', 'zeta']);
});

test('sortProjects in date mode orders by activity and ignores star colour', () => {
  const sorted = sortProjects(
    [
      dated('old', '2026-01-01T00:00:00Z', { isStarred: true, starColor: 'green' }),
      dated('new', '2026-03-01T00:00:00Z'),
      dated('mid', '2026-02-01T00:00:00Z', { isStarred: true, starColor: 'red' }),
    ],
    'date',
  );

  assert.deepEqual(names(sorted), ['new', 'mid', 'old']);
});

test('changing a project star colour leaves the sorted order identical', () => {
  const before = [
    project('alpha'),
    project('beta', { isStarred: true, starColor: 'yellow' }),
    project('gamma'),
  ];
  const recoloured = [
    project('alpha', { isStarred: true, starColor: 'red' }),
    project('beta'),
    project('gamma', { isStarred: true, starColor: 'green' }),
  ];

  assert.deepEqual(names(sortProjects(recoloured, 'name')), names(sortProjects(before, 'name')));
});

test('starAfterClick: an unstarred project becomes green', () => {
  assert.equal(starAfterClick(null, null), 'green');
  assert.equal(starAfterClick(null, 100), 'green');
});

test('starAfterClick: quick clicks climb green, yellow, orange, red', () => {
  assert.equal(starAfterClick('green', 500), 'yellow');
  assert.equal(starAfterClick('yellow', 1200), 'orange');
  assert.equal(starAfterClick('orange', STAR_CYCLE_WINDOW_MS - 1), 'red');
});

test('starAfterClick: a click after the window unstars', () => {
  assert.equal(starAfterClick('yellow', STAR_CYCLE_WINDOW_MS), null);
  assert.equal(starAfterClick('red', 4000), null);
});

test('starAfterClick: a starred project with no recorded click unstars', () => {
  assert.equal(starAfterClick('green', null), null);
});

test('starAfterClick: a quick click on red (past the top) unstars', () => {
  assert.equal(starAfterClick('red', 500), null);
});

test('nextStarFilter cycles off, focus, all, then off', () => {
  assert.equal(nextStarFilter('off'), 'focus');
  assert.equal(nextStarFilter('focus'), 'all');
  assert.equal(nextStarFilter('all'), 'off');
});

test('filterStarredProjects keeps every starred project, of any colour, and drops the rest', () => {
  const projects = [
    project('none'),
    project('green-one', { isStarred: true, starColor: 'green' }),
    project('yellow-one', { isStarred: true, starColor: 'yellow' }),
    project('legacy-star', { isStarred: true }),
    project('orange-one', { isStarred: true, starColor: 'orange' }),
    project('red-one', { isStarred: true, starColor: 'red' }),
    project('cleared', { isStarred: false, starColor: null }),
  ];

  assert.deepEqual(
    names(filterStarredProjects(projects)),
    ['green-one', 'yellow-one', 'legacy-star', 'orange-one', 'red-one'],
  );
});

test('filterStarredProjects: retired blue and purple count as green', () => {
  const projects = [
    project('old-blue', { isStarred: true, starColor: 'blue' as StarColor }),
    project('old-purple', { isStarred: true, starColor: 'purple' as StarColor }),
    project('red-one', { isStarred: true, starColor: 'red' }),
  ];

  assert.deepEqual(names(filterStarredProjects(projects)), ['old-blue', 'old-purple', 'red-one']);
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
