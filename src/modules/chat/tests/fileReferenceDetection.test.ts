import assert from 'node:assert/strict';

import { test } from 'vitest';

import { findTextFileReferences, inlineCodeFileReference } from '@/modules/chat/utils/fileReferences';

/**
 * Which paths in a chat message become file links outside markdown links.
 * Inline code is where a model quotes a path, so it is read generously; prose
 * is full of slashes and dots that are not paths, so it is read strictly.
 */

const referencesIn = (text: string) => findTextFileReferences(text).map((match) => match.reference);

test('inline code: absolute, home, dot-relative and slashed relative paths are links', () => {
  assert.equal(inlineCodeFileReference('/srv/u/projects/x/.claude/worktrees/foo'), '/srv/u/projects/x/.claude/worktrees/foo');
  assert.equal(inlineCodeFileReference('~/projects/x/notes.md'), '~/projects/x/notes.md');
  assert.equal(inlineCodeFileReference('./scripts/run'), './scripts/run');
  assert.equal(inlineCodeFileReference('../_play/report.html'), '../_play/report.html');
  assert.equal(inlineCodeFileReference('src/modules/chat'), 'src/modules/chat');
  assert.equal(inlineCodeFileReference('src/modules/'), 'src/modules/');
  assert.equal(inlineCodeFileReference('/etc/hosts'), '/etc/hosts');
});

test('inline code: a bare file name needs a known extension; a suffix line is kept', () => {
  assert.equal(inlineCodeFileReference('package.json'), 'package.json');
  assert.equal(inlineCodeFileReference('Markdown.tsx:291'), 'Markdown.tsx:291');
  assert.equal(inlineCodeFileReference('src/foo.ts:12:4'), 'src/foo.ts:12:4');
  assert.equal(inlineCodeFileReference(' src/foo.ts '), 'src/foo.ts');
  assert.equal(inlineCodeFileReference('JSON.parse'), null);
  assert.equal(inlineCodeFileReference('this.state'), null);
  assert.equal(inlineCodeFileReference('v1.2.3'), null);
  assert.equal(inlineCodeFileReference('3.14'), null);
});

test('inline code: commands, URLs, ratios and code are not paths', () => {
  for (const code of [
    '/compact',
    '/',
    '//',
    'https://example.com/a/b.html',
    'mailto:someone@example.com',
    'file:///etc/hosts',
    'npm run build',
    'git log --oneline -5',
    '--include=dev',
    '1/2',
    '10/09/2026',
    'a.b(c)',
    'src/*.ts',
    '$HOME/x',
    'foo || bar/baz',
    '<div>',
    '',
  ]) {
    assert.equal(inlineCodeFileReference(code), null, code);
  }
});

test('plain text: absolute, home and dot-relative paths are found, without their punctuation', () => {
  assert.deepEqual(
    referencesIn('Saved to /srv/u/projects/x/report.html. Also see ~/notes/todo.md, and (./run.sh).'),
    ['/srv/u/projects/x/report.html', '~/notes/todo.md', './run.sh'],
  );
  assert.deepEqual(referencesIn('The worktree is /srv/u/projects/x/.claude/worktrees/foo: open it'), [
    '/srv/u/projects/x/.claude/worktrees/foo',
  ]);
  assert.deepEqual(referencesIn('Error at src/foo.ts:12:4: unexpected token'), ['src/foo.ts:12:4']);
  assert.deepEqual(referencesIn('Line /srv/app/main.py:40.'), ['/srv/app/main.py:40']);
});

test('plain text: a relative path or bare name needs a known extension', () => {
  assert.deepEqual(referencesIn('Edit src/modules/chat/Markdown.tsx and README.md first.'), [
    'src/modules/chat/Markdown.tsx',
    'README.md',
  ]);
  assert.deepEqual(referencesIn('Look in src/modules for it.'), []);
});

test('plain text: ratios, prose, URLs, commands and framework names stay text', () => {
  for (const text of [
    'Use and/or the other, 1/2 of it, on 10/09/2026.',
    'Built with Node.js and Next.js, e.g. this.',
    'See https://example.com/docs/a.html and www.example.com/x.md for more.',
    'Mail me at someone@example.com.',
    'Run /compact when it gets long.',
    'A path/to/nothing without an extension.',
  ]) {
    assert.deepEqual(referencesIn(text), [], text);
  }
});

test('plain text: offsets cover exactly the reference', () => {
  const text = 'Open (/tmp/a.log).';
  const [match] = findTextFileReferences(text);
  assert.equal(text.slice(match.start, match.end), '/tmp/a.log');
});
