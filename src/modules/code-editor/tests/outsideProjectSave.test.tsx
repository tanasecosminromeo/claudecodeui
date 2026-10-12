import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type * as SharedApi from '@/shared/api';
import type { CodeEditorFile } from '@/shared/types';

/**
 * A writable file outside the project asks once before the first save of this
 * open file; a file inside the project saves without asking.
 */

const jsonResponse = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
});

const readFile = vi.fn(async () => jsonResponse(200, { content: 'hello', writable: true }));
const saveFile = vi.fn(async () => jsonResponse(200, { success: true }));

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof SharedApi>()),
  api: { readFile, saveFile },
}));

vi.mock('@/shared/context/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false, toggleDarkMode: () => undefined }),
}));

// A textarea stands in for CodeMirror; the buffer is all these tests need.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value, onChange }: { value: string; onChange?: (value: string) => void }) => (
    <textarea data-testid="editor" value={value} onChange={(event) => onChange?.(event.target.value)} />
  ),
}));

const { default: CodeEditor } = await import('@/modules/code-editor/CodeEditor');

const PROJECT_PATH = '/work/app';
const outsideFile: CodeEditorFile = { name: 'notes.txt', path: '/etc/app/notes.txt', projectId: 'p1' };
const otherOutsideFile: CodeEditorFile = { name: 'other.txt', path: '/etc/app/other.txt', projectId: 'p1' };
const insideFile: CodeEditorFile = { name: 'notes.txt', path: '/work/app/notes.txt', projectId: 'p1' };

const typeInEditor = async (value: string) => {
  const editor = await screen.findByTestId<HTMLTextAreaElement>('editor');
  fireEvent.change(editor, { target: { value } });
};

const pressSave = () => fireEvent.keyDown(document, { key: 's', ctrlKey: true });

test('saving a file outside the project asks first; Cancel keeps the edits unsaved', async () => {
  saveFile.mockClear();
  render(<CodeEditor file={outsideFile} projectPath={PROJECT_PATH} onClose={vi.fn()} />);
  await typeInEditor('hello world');

  fireEvent.click(screen.getByTitle('actions.save'));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Save outside the project?')).toBeTruthy();
  expect(within(dialog).getByText('/etc/app/notes.txt')).toBeTruthy();
  expect(within(dialog).getByText('This file is not in the project. Saving changes it on disk.')).toBeTruthy();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(saveFile).not.toHaveBeenCalled();
  expect(screen.getByRole('img', { name: 'Unsaved changes' })).toBeTruthy();
});

test('Save in the confirm writes once; later saves of the same file do not ask again', async () => {
  saveFile.mockClear();
  render(<CodeEditor file={outsideFile} projectPath={PROJECT_PATH} onClose={vi.fn()} />);
  await typeInEditor('hello world');

  pressSave();
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
  expect(saveFile).toHaveBeenCalledWith('p1', '/etc/app/notes.txt', 'hello world');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  await typeInEditor('hello again');
  pressSave();

  await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(2));
  expect(saveFile).toHaveBeenLastCalledWith('p1', '/etc/app/notes.txt', 'hello again');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('opening another file outside the project asks again', async () => {
  saveFile.mockClear();
  const { rerender } = render(<CodeEditor file={outsideFile} projectPath={PROJECT_PATH} onClose={vi.fn()} />);
  await typeInEditor('hello world');
  pressSave();
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));

  rerender(<CodeEditor file={otherOutsideFile} projectPath={PROJECT_PATH} onClose={vi.fn()} />);
  await typeInEditor('other text');
  pressSave();

  expect(await screen.findByRole('dialog')).toBeTruthy();
  expect(saveFile).toHaveBeenCalledTimes(1);
});

test('saving a file inside the project saves at once, with no confirm', async () => {
  saveFile.mockClear();
  render(<CodeEditor file={insideFile} projectPath={PROJECT_PATH} onClose={vi.fn()} />);
  await typeInEditor('hello world');

  fireEvent.click(screen.getByTitle('actions.save'));

  await waitFor(() => expect(saveFile).toHaveBeenCalledTimes(1));
  expect(saveFile).toHaveBeenCalledWith('p1', '/work/app/notes.txt', 'hello world');
  expect(screen.queryByRole('dialog')).toBeNull();
});
