import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type * as SharedApi from '@/shared/api';
import type { CodeEditorFile } from '@/shared/types';

/**
 * A file the OS will not let the server write (`writable: false` on the read)
 * opens read-only: a badge says why, there is no Save, and Ctrl/Cmd+S does not
 * reach the save API.
 */

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
});

const readFile = vi.fn(async () => jsonResponse(200, { content: 'root: owned', writable: false }));
const saveFile = vi.fn(async () => jsonResponse(200, { success: true }));

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedApi>()),
  api: { readFile, saveFile },
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

// A textarea stands in for CodeMirror; the read-only extension is wired in the
// editor, not exercised by this stub.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea data-testid="editor" value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

const systemFile: CodeEditorFile = { name: 'hosts.conf', path: '/work/app/hosts.conf', projectId: 'p1' };

test('a file the server cannot write shows a read-only badge and no Save', async () => {
  saveFile.mockClear();
  render(<CodeEditor file={systemFile} onClose={vi.fn()} />);

  await screen.findByTestId<HTMLTextAreaElement>('editor');
  const badge = screen.getByTitle('No permission to write this file.');
  expect(badge.textContent).toBe('Read-only');
  expect(screen.queryByTitle('actions.save')).toBeNull();
  expect(screen.getByText('Read-only • Esc to close')).toBeTruthy();
});

test('Ctrl+S does not save a file the server cannot write', async () => {
  saveFile.mockClear();
  render(<CodeEditor file={systemFile} onClose={vi.fn()} />);

  await screen.findByTestId('editor');
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });

  await waitFor(() => expect(saveFile).not.toHaveBeenCalled());
});
