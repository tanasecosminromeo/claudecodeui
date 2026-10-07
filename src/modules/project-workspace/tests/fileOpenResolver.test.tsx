import assert from 'node:assert/strict';

import { renderHook, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guards for where a chat file reference ends up.
 *
 * An absolute path must open the file it names. `findBestMatch` falls back to
 * matching by filename, which is what makes bare references like `foo.ts`
 * work. Applied to an absolute path it silently rewrote the reference: asking
 * for `~/.config/CLAUDE.md` opened the project's own `CLAUDE.md` — a
 * different file, with no error, indistinguishable from the right one.
 *
 * A reference the project does not hold must be looked for next to the paths
 * its message mentions, and one found nowhere must say so instead of opening
 * an editor on a file that is not there: "Two reports, both under
 * `~/play/files/`: [report.html](report.html)" opened `report.html` against the
 * project root and showed "// Error loading file: File not found".
 */

const getFiles = vi.fn();
const resolveFile = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    getFiles: (...args: unknown[]) => getFiles(...args),
    resolveFile: (...args: unknown[]) => resolveFile(...args),
  },
}));

const { buildCandidates, useFileOpenResolver } = await import('@/modules/project-workspace/hooks/useFileOpenResolver');

const ROOT = '/u/me/workspace/personal';
const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT };

const tree = [
  { type: 'file', name: 'CLAUDE.md', path: `${ROOT}/CLAUDE.md` },
  {
    type: 'directory',
    name: 'src',
    path: `${ROOT}/src`,
    children: [{ type: 'file', name: 'foo.ts', path: `${ROOT}/src/foo.ts` }],
  },
];

// Stands in for the server: the first candidate in `readable` wins, else the
// first in `blocked` is reported. Paths come back expanded, as the server's are.
const setup = ({
  readable = [] as string[],
  blocked = [] as string[],
  resolveStatus = 200,
} = {}) => {
  getFiles.mockReset();
  getFiles.mockResolvedValue({ ok: true, json: async () => tree });
  resolveFile.mockReset();
  resolveFile.mockImplementation(async (_projectId: string, candidates: string[]) => ({
    ok: resolveStatus === 200,
    json: async () => ({
      path: candidates.find((candidate) => readable.includes(candidate))?.replace(/^~/, '/u/me') ?? null,
      blockedPath: candidates.find((candidate) => blocked.includes(candidate)) ?? null,
    }),
  }));
  const onFileOpen = vi.fn();
  const onUnresolved = vi.fn();
  const { result } = renderHook(() => useFileOpenResolver(project, onFileOpen, onUnresolved));
  return { resolve: result.current, onFileOpen, onUnresolved };
};

const settled = async (onFileOpen: ReturnType<typeof vi.fn>, onUnresolved: ReturnType<typeof vi.fn>) =>
  waitFor(() => assert.equal(onFileOpen.mock.calls.length + onUnresolved.mock.calls.length, 1));

test('an absolute path outside the project opens that path, never a same-named project file', async () => {
  const { resolve, onFileOpen, onUnresolved } = setup({ readable: ['/u/me/.claude/CLAUDE.md'] });
  resolve('/u/me/.claude/CLAUDE.md');
  await settled(onFileOpen, onUnresolved);
  assert.equal(onFileOpen.mock.calls[0][0], '/u/me/.claude/CLAUDE.md');
  // It does not need the tree, so that request never goes out.
  assert.equal(getFiles.mock.calls.length, 0);
  assert.deepEqual(resolveFile.mock.calls[0], ['p1', ['/u/me/.claude/CLAUDE.md']]);
});

test('an absolute path that does not exist is reported, not opened', async () => {
  const { resolve, onFileOpen, onUnresolved } = setup();
  resolve('/u/me/.claude/CLAUDE.md');
  await settled(onFileOpen, onUnresolved);
  assert.equal(onFileOpen.mock.calls.length, 0);
  assert.deepEqual(onUnresolved.mock.calls[0][0], { reference: '/u/me/.claude/CLAUDE.md', blockedPath: null });
});

test('an absolute path inside the project resolves to itself, as before', async () => {
  const { resolve, onFileOpen, onUnresolved } = setup({ readable: [`${ROOT}/src/foo.ts`] });
  resolve(`${ROOT}/src/foo.ts`);
  await settled(onFileOpen, onUnresolved);
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);
});

test('partial references still match against the tree, without asking the server', async () => {
  const { resolve, onFileOpen, onUnresolved } = setup();
  resolve('foo.ts');
  await settled(onFileOpen, onUnresolved);
  assert.equal(onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);

  const second = setup();
  second.resolve('src/foo.ts');
  await settled(second.onFileOpen, second.onUnresolved);
  assert.equal(second.onFileOpen.mock.calls[0][0], `${ROOT}/src/foo.ts`);
  assert.equal(resolveFile.mock.calls.length, 0);
});

test('a bare name the project lacks is found in a folder its message mentions', async () => {
  const { resolve, onFileOpen, onUnresolved } = setup({ readable: ['~/play/files/report.html'] });
  resolve('report.html', undefined, null, ['~/play/files/', '/srv/other']);
  await settled(onFileOpen, onUnresolved);
  assert.equal(onFileOpen.mock.calls[0][0], '/u/me/play/files/report.html');
  assert.deepEqual(resolveFile.mock.calls[0][1], [
    'report.html',
    '~/play/files/report.html',
    '/srv/other/report.html',
  ]);
});

test('a file outside every readable root is reported with its path', async () => {
  const { resolve, onFileOpen, onUnresolved } = setup({ blocked: ['/srv/play/report.html'] });
  resolve('report.html', undefined, null, ['/srv/play']);
  await settled(onFileOpen, onUnresolved);
  assert.equal(onFileOpen.mock.calls.length, 0);
  assert.deepEqual(onUnresolved.mock.calls[0][0], { reference: 'report.html', blockedPath: '/srv/play/report.html' });
});

test('with no answer from the server the reference opens as given, as before', async () => {
  const { resolve, onFileOpen, onUnresolved } = setup({ resolveStatus: 404 });
  resolve('nope.ts');
  await settled(onFileOpen, onUnresolved);
  assert.equal(onFileOpen.mock.calls[0][0], 'nope.ts');
});

test('diffInfo and line survive resolution', async () => {
  const { resolve, onFileOpen, onUnresolved } = setup({ readable: ['/u/me/.claude/CLAUDE.md'] });
  const diffInfo = { old_string: 'a', new_string: 'b' };
  resolve('/u/me/.claude/CLAUDE.md', diffInfo, 150);
  await settled(onFileOpen, onUnresolved);
  assert.deepEqual(onFileOpen.mock.calls[0].slice(1), [diffInfo, 150]);
});

test('surrounding whitespace never reaches the API as part of the path', async () => {
  const { resolve, onFileOpen, onUnresolved } = setup({ readable: ['/u/me/.claude/CLAUDE.md'] });
  resolve('  /u/me/.claude/CLAUDE.md ');
  await settled(onFileOpen, onUnresolved);
  assert.equal(onFileOpen.mock.calls[0][0], '/u/me/.claude/CLAUDE.md');

  const second = setup();
  second.resolve('nope.ts ');
  await settled(second.onFileOpen, second.onUnresolved);
  assert.equal(second.onUnresolved.mock.calls[0][0].reference, 'nope.ts');
});

test('buildCandidates: a hint naming the same file is tried as is; absolute references stand alone', () => {
  assert.deepEqual(buildCandidates('./report.html', ['/srv/out/report.html', '/srv/out/']), [
    './report.html',
    '/srv/out/report.html',
    '/srv/out/report.html/report.html',
  ]);
  assert.deepEqual(buildCandidates('~/notes.md', ['/srv/out/']), ['~/notes.md']);
});
