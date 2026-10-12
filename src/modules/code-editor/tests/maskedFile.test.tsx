import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type * as SharedApi from '@/shared/api';
import type { CodeEditorFile } from '@/shared/types';

/**
 * A normal file that holds key-like values comes back with its values masked
 * (`masked: true`). It is shown read-only under a banner: nothing can save it,
 * and a save the server still refuses (`MASKED_FILE`) says why.
 */

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
});

const readFile = vi.fn(async () => jsonResponse(200, { content: 'API_KEY=••••', masked: true }));
const saveFile = vi.fn(async () => jsonResponse(200, { success: true }));

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedApi>()),
  api: { readFile, saveFile },
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

// A textarea stands in for CodeMirror; the read-only extension is covered by
// the editor's own wiring, not by this stub.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea data-testid="editor" value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

const configFile: CodeEditorFile = { name: 'config.env.example', path: '/work/app/config.env.example', projectId: 'p1' };

test('a masked file is shown under the banner, with no save or download', async () => {
  render(<CodeEditor file={configFile} onClose={vi.fn()} />);

  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  expect(editor.value).toBe('API_KEY=••••');
  expect(screen.getByRole('status').textContent).toContain('Contains key-like values: shown masked (••••), read-only here.');
  expect(screen.queryByTitle('actions.save')).toBeNull();
  expect(screen.queryByTitle('actions.download')).toBeNull();
});

test('Ctrl+S does not write a masked file', async () => {
  saveFile.mockClear();
  render(<CodeEditor file={configFile} onClose={vi.fn()} />);

  await screen.findByTestId('editor');
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });

  await waitFor(() => expect(saveFile).not.toHaveBeenCalled());
});

test('a save the server refuses as masked says so, not a generic failure', async () => {
  readFile.mockResolvedValueOnce(jsonResponse(200, { content: 'hello' }));
  saveFile.mockResolvedValueOnce(jsonResponse(403, {
    error: 'Contains key-like values: read-only here.',
    code: 'MASKED_FILE',
  }));
  render(<CodeEditor file={{ name: 'notes.txt', path: '/work/app/notes.txt', projectId: 'p1' }} onClose={vi.fn()} />);

  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  fireEvent.change(editor, { target: { value: 'hello world' } });
  fireEvent.keyDown(document, { key: 's', ctrlKey: true });

  expect(await screen.findByText('Contains key-like values: read-only here.')).toBeTruthy();
  expect(screen.queryByText(/Save failed/)).toBeNull();
});
