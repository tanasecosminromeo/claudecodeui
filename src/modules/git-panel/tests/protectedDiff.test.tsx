import assert from 'node:assert/strict';

import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { GitBranchDiffResponse, GitFileDiffResponse } from '@/shared/types';
import CompareFileItem from '@/modules/git-panel/compare/CompareFileItem';
import FileChangeItem from '@/modules/git-panel/changes/FileChangeItem';

/**
 * Env, key and credential files have no diff the server will show. Their
 * diff requests answer PROTECTED_FILE, which is expected, so the Source Control
 * rows say so in the diff area instead of showing an error.
 */

const PROTECTED_PAYLOAD: GitFileDiffResponse = {
  error: 'Protected: may contain keys. Contents hidden.',
  code: 'PROTECTED_FILE',
};

const pendingBranchDiffs: { resolve: (payload: GitBranchDiffResponse) => void }[] = [];
const branchDiffFileResponses: Record<string, GitFileDiffResponse> = {};

vi.mock('@/shared/api', () => ({
  api: {
    git: {
      branchDiff: () => new Promise<{ json: () => Promise<GitBranchDiffResponse> }>((resolve) => {
        pendingBranchDiffs.push({
          resolve: (payload) => resolve({ json: async () => payload }),
        });
      }),
      branchDiffFile: (_projectId: string, _base: string, filePath: string) => {
        const payload = branchDiffFileResponses[filePath] ?? { diff: `@@ diff of ${filePath} @@` };
        return Promise.resolve({ json: async () => payload });
      },
    },
  },
}));

const renderCompare = async () => {
  const { useBranchCompare } = await import('@/modules/git-panel/hooks/useBranchCompare');
  return renderHook(() => useBranchCompare({
    projectId: 'project-1',
    currentBranch: 'feature',
    localBranches: ['feature', 'main'],
    remoteRefs: [],
    gitStatus: null,
  }));
};

beforeEach(() => {
  pendingBranchDiffs.length = 0;
  for (const key of Object.keys(branchDiffFileResponses)) {
    delete branchDiffFileResponses[key];
  }
});

afterEach(() => {
  vi.resetModules();
});

test('a file the server hides is recorded as protected, not as a failed load', async () => {
  const { PROTECTED_FILE_ERROR } = await import('@/modules/git-panel/hooks/useBranchCompare');
  const { result } = await renderCompare();

  act(() => {
    pendingBranchDiffs[0].resolve({ base: 'main', mergeBase: 'abc', files: [{ path: '.env', status: 'M' }] });
  });
  await waitFor(() => assert.equal(result.current.files.length, 1));

  branchDiffFileResponses['.env'] = PROTECTED_PAYLOAD;
  await act(async () => {
    await result.current.loadFileDiff({ path: '.env', status: 'M' });
  });

  assert.equal(result.current.fileDiffErrors['.env'], PROTECTED_FILE_ERROR);
  assert.equal(result.current.fileDiffs['.env'], undefined);
});

test('a compare row for a protected file shows the notice in place of its diff', () => {
  render(
    <CompareFileItem
      file={{ path: '.env', status: 'M' }}
      isMobile={false}
      isExpanded
      isProtected
      wrapText={false}
      onToggleExpanded={vi.fn()}
      onOpenFile={vi.fn()}
      onToggleWrapText={vi.fn()}
    />,
  );

  const notice = screen.getByTestId('protected-file-notice');
  expect(notice.textContent).toContain('Protected: may contain keys. Contents hidden.');
  expect(notice.textContent).toContain('.env');
  expect(screen.queryByText(/Could not load this diff/)).toBeNull();
});

test('a changes row for a protected file shows the notice when expanded', () => {
  render(
    <FileChangeItem
      filePath=".env"
      status="M"
      isMobile={false}
      isExpanded
      isSelected={false}
      isProtected
      wrapText={false}
      onToggleSelected={vi.fn()}
      onToggleExpanded={vi.fn()}
      onOpenFile={vi.fn()}
      onToggleWrapText={vi.fn()}
      onRequestFileAction={vi.fn()}
    />,
  );

  expect(screen.getByTestId('protected-file-notice').textContent).toContain('.env');
});
