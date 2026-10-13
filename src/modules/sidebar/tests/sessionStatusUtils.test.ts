import assert from 'node:assert/strict';

import { expect, test } from 'vitest';

import type { ProjectSession, SessionWithProvider } from '@/shared/types';
import { createSessionViewModel } from '@/modules/sidebar/utils/sidebarProjectFormatting';
import {
  SESSION_STATUS_EMOJI,
  SESSION_STATUS_KEYS,
  getSessionStatusEmoji,
  isSessionStatusKey,
} from '@/modules/sidebar/utils/sessionStatus';

const t = ((key: string) => key) as never;

test('the status keys and their emoji match the server status set', () => {
  assert.deepEqual(SESSION_STATUS_KEYS, [
    'bug', 'investigation', 'testing', 'planning', 'building',
    'refactor', 'release', 'question', 'done', 'blocked',
  ]);
  assert.deepEqual(
    SESSION_STATUS_KEYS.map((key) => SESSION_STATUS_EMOJI[key]),
    ['🐛', '🔍', '🧪', '📝', '🛠️', '♻️', '🚀', '❓', '✅', '⏸️'],
  );
});

test('getSessionStatusEmoji returns nothing for a missing or unknown status', () => {
  assert.equal(getSessionStatusEmoji(null), null);
  assert.equal(getSessionStatusEmoji(undefined), null);
  assert.equal(getSessionStatusEmoji('sleeping'), null);
  assert.equal(getSessionStatusEmoji('bug'), '🐛');
  assert.equal(isSessionStatusKey('blocked'), true);
  assert.equal(isSessionStatusKey('Blocked'), false);
});

test('the session name never carries the status emoji', () => {
  const session = {
    id: 's1',
    summary: 'Fix login test',
    status: 'bug',
    statusSource: 'auto',
    nameSource: 'auto',
    __provider: 'claude',
  } as unknown as SessionWithProvider & ProjectSession;

  const view = createSessionViewModel(session, new Date('2026-08-21T10:00:00.000Z'), t);

  expect(view.sessionName).toBe('Fix login test');
  expect(view.sessionName.includes(SESSION_STATUS_EMOJI.bug)).toBe(false);
});
