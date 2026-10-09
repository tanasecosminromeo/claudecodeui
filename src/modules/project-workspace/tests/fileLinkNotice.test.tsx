import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test } from 'vitest';

import FileLinkNotice from '@/modules/project-workspace/FileLinkNotice';

/**
 * Any file the server process may read opens, so a link that does not open is
 * either missing or refused by the OS. The notice says which: "not found"
 * sends the user looking for a typo, "no permission" to the file's mode.
 */

const noop = () => undefined;

test('a file the server may not read says so, with the path it tried', () => {
  render(<FileLinkNotice notice={{ reference: 'report.html', deniedPath: '/srv/play/report.html' }} onDismiss={noop} />);
  const notice = screen.getByTestId('file-link-notice');
  assert.match(notice.textContent ?? '', /No permission to read/);
  assert.match(notice.textContent ?? '', /\/srv\/play\/report\.html/);
  assert.doesNotMatch(notice.textContent ?? '', /READ_ONLY_ROOTS|outside the project/);
});

test('a missing file says it was not found, with the reference as written', () => {
  render(<FileLinkNotice notice={{ reference: '~/notes/missing.md', deniedPath: null }} onDismiss={noop} />);
  const notice = screen.getAllByTestId('file-link-notice').at(-1)!;
  assert.match(notice.textContent ?? '', /File not found/);
  assert.match(notice.textContent ?? '', /~\/notes\/missing\.md/);
});
