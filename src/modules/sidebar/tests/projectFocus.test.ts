import assert from 'node:assert/strict';

import { beforeEach, expect, test, vi } from 'vitest';

import type { Project, SessionWithProvider } from '@/shared/types';
import {
  filterProjectsToFocus,
  isSessionRecent,
} from '@/modules/sidebar/utils/sidebarProjectFormatting';

const NOW = new Date('2026-10-13T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS).toISOString();

const session = (id: string, hours: number): SessionWithProvider => ({
  id,
  lastActivity: hoursAgo(hours),
  __provider: 'claude',
});

const project = (projectId: string, sessions: SessionWithProvider[]): Project => ({
  projectId,
  displayName: projectId,
  fullPath: `/work/${projectId}`,
  sessions,
  sessionMeta: { total: sessions.length, hasMore: false },
});

const NONE_ACTIVE = new Set<string>();

test('a session last used 23 hours ago is recent', () => {
  assert.equal(isSessionRecent(session('s1', 23), NONE_ACTIVE, NOW), true);
});

test('a session last used 25 hours ago is not recent', () => {
  assert.equal(isSessionRecent(session('s1', 25), NONE_ACTIVE, NOW), false);
});

test('an old session still in activeSessions is recent (a Monitor keeps it running)', () => {
  assert.equal(isSessionRecent(session('s1', 300), new Set(['s1']), NOW), true);
});

test('filterProjectsToFocus keeps a project with mixed sessions, listing only its recent ones', () => {
  const mixed = project('client-a', [session('fresh', 2), session('stale', 48), session('monitor', 90)]);
  const [focused] = filterProjectsToFocus([mixed], new Set(['monitor']), NOW);

  assert.equal(focused.projectId, 'client-a');
  assert.deepEqual(focused.sessions?.map((entry) => entry.id), ['fresh', 'monitor']);
  assert.equal(focused.sessionMeta?.total, 2);
  assert.equal(focused.sessionMeta?.hasMore, false);
  // The input project is not changed: the trimmed copy is a new object.
  assert.equal(mixed.sessions?.length, 3);
  assert.equal(focused === mixed, false);
});

test('filterProjectsToFocus drops a project with no recent session', () => {
  const stale = project('client-b-site', [session('old', 30)]);
  const focused = filterProjectsToFocus([stale, project('empty', [])], NONE_ACTIVE, NOW);

  assert.deepEqual(focused, []);
});

test('filterProjectsToFocus keeps the order of the projects it is given', () => {
  const projects = [
    project('zeta', [session('z', 1)]),
    project('alpha', [session('a', 40)]),
    project('mid', [session('m', 5)]),
  ];

  assert.deepEqual(
    filterProjectsToFocus(projects, NONE_ACTIVE, NOW).map((entry) => entry.projectId),
    ['zeta', 'mid'],
  );
});

test('the stored star filter keeps focus and all, maps a colour to all, and any other value to off', async () => {
  // The store reads its localStorage mirror once, at module load, so each case loads a fresh copy.
  const readWith = async (stored: unknown) => {
    vi.resetModules();
    localStorage.setItem('user-preferences', JSON.stringify({ projectStarFilter: stored }));
    const { readProjectStarFilter } = await import('@/modules/sidebar/utils/sidebarStoredPreferences');
    return readProjectStarFilter();
  };

  expect(await readWith('focus')).toBe('focus');
  expect(await readWith('all')).toBe('all');
  expect(await readWith('red')).toBe('all');
  expect(await readWith('green')).toBe('all');
  expect(await readWith('orange')).toBe('all');
  expect(await readWith('yellow')).toBe('all');
  expect(await readWith('blue')).toBe('off');
  expect(await readWith('garbage')).toBe('off');
  expect(await readWith(42)).toBe('off');
});

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});
