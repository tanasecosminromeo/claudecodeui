import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type * as SharedApi from '@/shared/api';
import type { CodeEditorFile } from '@/shared/types';

/**
 * An env, key or credential file is listed in the tree but its contents are
 * never sent. Opening one shows a calm notice with the path, and nothing that
 * could save or download the (empty) buffer.
 */

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const readFile = vi.fn(async () => jsonResponse(403, {
  error: 'Protected: may contain keys. Contents hidden.',
  code: 'PROTECTED_FILE',
}));
const saveFile = vi.fn(async () => jsonResponse(200, { success: true }));

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedApi>()),
  api: { readFile, saveFile },
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value }: { value: string }) => <textarea data-testid="editor" value={value} readOnly />,
}));

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

const envFile: CodeEditorFile = { name: '.env', path: '/work/app/.env', projectId: 'p1' };

test('a protected file shows the notice with its path, in place of the contents', async () => {
  render(<CodeEditor file={envFile} onClose={vi.fn()} />);

  const notice = await screen.findByTestId('protected-file-notice');
  expect(notice.textContent).toContain('Protected: may contain keys. Contents hidden.');
  expect(notice.textContent).toContain('/work/app/.env');
  expect(screen.queryByTestId('editor')).toBeNull();
});

test('a protected file has no save or download, and no error styling', async () => {
  render(<CodeEditor file={envFile} onClose={vi.fn()} />);

  await screen.findByTestId('protected-file-notice');
  expect(screen.queryByTitle('actions.save')).toBeNull();
  expect(screen.queryByTitle('actions.download')).toBeNull();
  expect(screen.queryByText(/Error loading file/)).toBeNull();
  expect(document.querySelector('.text-red-700')).toBeNull();
});

test('Ctrl+S does not write a protected file', async () => {
  saveFile.mockClear();
  render(<CodeEditor file={envFile} onClose={vi.fn()} />);

  await screen.findByTestId('protected-file-notice');
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });

  await waitFor(() => expect(saveFile).not.toHaveBeenCalled());
});
