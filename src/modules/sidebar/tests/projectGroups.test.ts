import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { Project, ProjectGroup, ProjectSession } from '@/shared/types';
import {
  buildProjectSections,
  filterProjectsByStar,
  getStarColorsInUse,
  sortProjects,
} from '@/modules/sidebar/utils/sidebarProjectFormatting';
import {
  STAR_CYCLE_WINDOW_MS,
  getStarColor,
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

test('sortProjects orders by name and ignores star colour', () => {
  const sorted = sortProjects(
    [
      project('zeta', { isStarred: true, starColor: 'yellow' }),
      project('alpha'),
      project('mid', { isStarred: true, starColor: 'purple' }),
      project('beta', { isStarred: true, starColor: 'blue' }),
    ],
    'name',
  );

  assert.deepEqual(names(sorted), ['alpha', 'beta', 'mid', 'zeta']);
});

test('sortProjects in date mode orders by activity and ignores star colour', () => {
  const sorted = sortProjects(
    [
      dated('old', '2026-01-01T00:00:00Z', { isStarred: true, starColor: 'yellow' }),
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
    project('alpha', { isStarred: true, starColor: 'purple' }),
    project('beta'),
    project('gamma', { isStarred: true, starColor: 'green' }),
  ];

  assert.deepEqual(names(sortProjects(recoloured, 'name')), names(sortProjects(before, 'name')));
});

test('starAfterClick: an unstarred project becomes yellow', () => {
  assert.equal(starAfterClick(null, null), 'yellow');
  assert.equal(starAfterClick(null, 100), 'yellow');
});

test('starAfterClick: a quick click moves to the next colour', () => {
  assert.equal(starAfterClick('yellow', 1200), 'orange');
  assert.equal(starAfterClick('yellow', STAR_CYCLE_WINDOW_MS - 1), 'orange');
});

test('starAfterClick: a click after the window unstars', () => {
  assert.equal(starAfterClick('yellow', STAR_CYCLE_WINDOW_MS), null);
  assert.equal(starAfterClick('blue', 4000), null);
});

test('starAfterClick: a starred project with no recorded click unstars', () => {
  assert.equal(starAfterClick('green', null), null);
});

test('starAfterClick: a quick click on purple unstars', () => {
  assert.equal(starAfterClick('purple', 500), null);
});

test('nextStarFilter cycles off, all, then only the colours in use', () => {
  const inUse = ['orange', 'blue'] as const;
  assert.equal(nextStarFilter('off', inUse), 'all');
  assert.equal(nextStarFilter('all', inUse), 'orange');
  assert.equal(nextStarFilter('orange', inUse), 'blue');
  assert.equal(nextStarFilter('blue', inUse), 'off');
});

test('nextStarFilter with no starred projects goes off, all, off', () => {
  assert.equal(nextStarFilter('off', []), 'all');
  assert.equal(nextStarFilter('all', []), 'off');
});

test('nextStarFilter treats a colour nobody has any more as all', () => {
  assert.equal(nextStarFilter('red', ['orange', 'blue']), 'orange');
  assert.equal(nextStarFilter('red', []), 'off');
});

test('filterProjectsByStar keeps starred, one colour, or everything', () => {
  const projects = [
    project('none'),
    project('yellow-stored', { isStarred: true, starColor: 'yellow' }),
    project('blue-one', { isStarred: true, starColor: 'blue' }),
    project('legacy-star', { isStarred: true }),
    project('cleared', { isStarred: false, starColor: null }),
  ];

  assert.deepEqual(names(filterProjectsByStar(projects, 'off')), ['none', 'yellow-stored', 'blue-one', 'legacy-star', 'cleared']);
  assert.deepEqual(names(filterProjectsByStar(projects, 'all')), ['yellow-stored', 'blue-one', 'legacy-star']);
  assert.deepEqual(names(filterProjectsByStar(projects, 'yellow')), ['yellow-stored', 'legacy-star']);
  assert.deepEqual(names(filterProjectsByStar(projects, 'blue')), ['blue-one']);
  assert.deepEqual(names(filterProjectsByStar(projects, 'purple')), []);
});

test('getStarColorsInUse lists the colours present, in chip order', () => {
  const projects = [
    project('a', { isStarred: true, starColor: 'blue' }),
    project('b'),
    project('c', { isStarred: true, starColor: 'yellow' }),
    project('d', { isStarred: true, starColor: 'blue' }),
  ];

  assert.deepEqual(getStarColorsInUse(projects), ['yellow', 'blue']);
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
