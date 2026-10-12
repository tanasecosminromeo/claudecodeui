import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { FileTreeNode as FileTreeNodeType } from '@/shared/types';
import FileTreeNode from '@/modules/file-tree/FileTreeNode';

/**
 * A protected file (env, key, credential) stays in the tree so the user sees
 * it exists, marked with a lock. The lock never blocks opening the row: the
 * editor then explains why there is nothing to read.
 */

const renderRow = (item: FileTreeNodeType, onItemClick = vi.fn()) => render(
  <FileTreeNode
    item={item}
    level={0}
    viewMode="simple"
    expandedDirs={new Set()}
    onItemClick={onItemClick}
    renderFileIcon={() => null}
    formatFileSize={() => ''}
    formatRelativeTime={() => ''}
  />,
);

test('a protected row shows a lock titled as hidden contents', () => {
  renderRow({ type: 'file', name: '.env', path: '/work/app/.env', protected: true });

  expect(screen.getByTitle('Protected: contents hidden')).toBeTruthy();
  expect(screen.getByText('.env')).toBeTruthy();
});

test('a normal row shows no lock', () => {
  renderRow({ type: 'file', name: 'index.ts', path: '/work/app/index.ts' });

  expect(screen.queryByTitle('Protected: contents hidden')).toBeNull();
});

test('clicking a protected row still opens it', () => {
  const onItemClick = vi.fn();
  const item: FileTreeNodeType = { type: 'file', name: '.env', path: '/work/app/.env', protected: true };
  renderRow(item, onItemClick);

  fireEvent.click(screen.getByTitle('Protected: contents hidden'));

  expect(onItemClick).toHaveBeenCalledWith(item);
});
