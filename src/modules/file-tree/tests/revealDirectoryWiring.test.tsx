import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { test, vi } from 'vitest';

import type { Project } from '@/shared/types';

/**
 * Regression guard for the wiring, not the maths: a directory reference clicked
 * in the chat reaches the tree as the model wrote it — relative to the project
 * root — while every node here is keyed by its absolute path. Rendering the
 * real tree is what proves the two ends still meet.
 */

const ROOT = '/home/odoo/workspace/personal';

const tree = [
  {
    type: 'directory',
    name: 'decisions',
    path: `${ROOT}/decisions`,
    children: [{ type: 'file', name: '0001-first.md', path: `${ROOT}/decisions/0001-first.md` }],
  },
];

const OUTSIDE = '/srv/play/reports';
const outsideTree = [
  { type: 'file', name: 'report.html', path: `${OUTSIDE}/report.html` },
];
const getFolderFiles = vi.fn(async () => ({ ok: true, json: async () => outsideTree }));

vi.mock('@/shared/api', () => ({
  api: {
    getFiles: async () => ({ ok: true, json: async () => tree }),
    getFolderFiles: (...args: unknown[]) => getFolderFiles(...(args as [])),
  },
}));

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: 'p1', displayName: 'personal', fullPath: ROOT, path: ROOT };

test('a relative directory reference expands that folder in the tree', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'decisions/' }} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  // Visible only because the folder was expanded for us.
  await waitFor(() => assert.ok(screen.getByText('0001-first.md')));
});

test('a folder nobody asked for stays closed', async () => {
  render(<FileTree selectedProject={project} revealDirectory={null} />);

  await waitFor(() => assert.ok(screen.getByText('decisions')));
  assert.equal(screen.queryByText('0001-first.md'), null);
});

test('a folder outside the project opens read-only, and the project is one click back', async () => {
  const onFileOpen = vi.fn();
  render(<FileTree selectedProject={project} onFileOpen={onFileOpen} revealDirectory={{ path: `${OUTSIDE}/` }} />);

  await waitFor(() => assert.ok(screen.getByText('report.html')));
  assert.deepEqual((getFolderFiles.mock.calls[0] as unknown[]).slice(0, 2), ['p1', OUTSIDE]);
  assert.ok(screen.getByTestId('file-tree-read-only-root').textContent?.includes(OUTSIDE));
  // Nothing outside the project can be changed, so nothing offers to.
  assert.equal(screen.queryByRole('button', { name: /New File/ }), null);
  assert.equal(screen.queryByRole('button', { name: /Upload files/ }), null);

  fireEvent.click(screen.getByText('report.html'));
  assert.deepEqual(onFileOpen.mock.calls[0], [`${OUTSIDE}/report.html`]);

  fireEvent.click(screen.getByRole('button', { name: /Back to project/ }));
  await waitFor(() => assert.ok(screen.getByText('decisions')));
  assert.equal(screen.queryByTestId('file-tree-read-only-root'), null);
});
