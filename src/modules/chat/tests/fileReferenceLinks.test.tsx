import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

/**
 * Regression guard: what a file reference in a chat message hands to the
 * editor. Both suffix helpers are anchored at the end of the string, so a
 * reference picked up from the link text — which, unlike the href, keeps the
 * whitespace around it — used to reach the API with `:12 ` still attached and
 * answer a 404.
 */

const openFileInEditor = vi.fn();
const openDirectory = vi.fn();

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor, openDirectory }),
}));

const { Markdown } = await import('@/modules/chat/transcript/Markdown');

const clickReference = (markdown: string, linkText: string) => {
  openFileInEditor.mockReset();
  openDirectory.mockReset();
  render(<Markdown>{markdown}</Markdown>);
  fireEvent.click(screen.getByText(linkText));
};

test('a `path:line` reference opens the path without its suffix, at that line', () => {
  clickReference('See [src/foo.ts:130](src/foo.ts:130).', 'src/foo.ts:130');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 130, []]);
});

test('whitespace around a reference taken from the link text is dropped', () => {
  clickReference('See [`src/foo.ts:12` ]().', 'src/foo.ts:12');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 12, []]);
});

test('a directory reference goes to the file tree, not the editor', () => {
  clickReference('See [decisions/](decisions/).', 'decisions/');
  assert.equal(openFileInEditor.mock.calls.length, 0);
  assert.deepEqual(openDirectory.mock.calls[0], ['decisions/']);
});

test('a plain file reference opens with no line', () => {
  clickReference('See [src/foo.ts](src/foo.ts).', 'src/foo.ts');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', null, []]);
});

test('a link carries the absolute paths its message mentions, to look for it there', () => {
  clickReference(
    'Two reports, both under `~/play/2026-10-04/files/`:\n\n- Staging: [staging-e2e-report.html](staging-e2e-report.html)\n- See https://example.com/a/b and /var/log/app.log.',
    'staging-e2e-report.html',
  );
  assert.deepEqual(openFileInEditor.mock.calls[0], [
    'staging-e2e-report.html',
    null,
    ['~/play/2026-10-04/files/', '/var/log/app.log'],
  ]);
});

test('a path in inline code is a link that keeps its code look', () => {
  clickReference('The file is `/srv/u/projects/x/notes.md:12`.', '/srv/u/projects/x/notes.md:12');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['/srv/u/projects/x/notes.md', 12, ['/srv/u/projects/x/notes.md:12']]);
  const code = screen.getByText('/srv/u/projects/x/notes.md:12');
  assert.equal(code.tagName, 'CODE');
  assert.equal(code.closest('a')?.getAttribute('data-file-ref'), '/srv/u/projects/x/notes.md:12');
});

test('a path in plain text is a link, without the sentence punctuation after it', () => {
  clickReference('Saved the report to ~/play/report.html. Open it.', '~/play/report.html');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['~/play/report.html', null, ['~/play/report.html']]);
});

test('a folder in inline code goes to the file tree', () => {
  clickReference('Everything is under `src/modules/`.', 'src/modules/');
  assert.equal(openFileInEditor.mock.calls.length, 0);
  assert.deepEqual(openDirectory.mock.calls[0], ['src/modules/']);
});

test('a folder without a trailing slash still goes through the resolver, which knows it is one', () => {
  clickReference('The worktree is `/srv/u/projects/x/.claude/worktrees/foo`.', '/srv/u/projects/x/.claude/worktrees/foo');
  assert.deepEqual(openFileInEditor.mock.calls[0][0], '/srv/u/projects/x/.claude/worktrees/foo');
});

test('paths in fenced code, URLs and commands are left alone', () => {
  render(
    <Markdown>
      {'```\ncat /etc/hosts\n```\n\nRun `/compact`, read https://example.com/a/b.html and `npm run build`.'}
    </Markdown>,
  );
  assert.equal(screen.getByText(/cat \/etc\/hosts/).closest('a'), null);
  assert.equal(screen.getByText('/compact').closest('a'), null);
  assert.equal(screen.getByText('npm run build').closest('a'), null);
  assert.equal(screen.getByText('https://example.com/a/b.html').closest('a')?.getAttribute('target'), '_blank');
});

test('a markdown link around a path is not linked twice', () => {
  render(<Markdown>{'See [`src/foo.ts`](src/foo.ts) and [the docs](docs/README.md).'}</Markdown>);
  assert.equal(document.querySelectorAll('a a').length, 0);
  assert.equal(screen.getByText('src/foo.ts').closest('a')?.getAttribute('href'), 'src/foo.ts');
});
