import assert from 'node:assert/strict';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';
import { SESSION_STATUS_EMOJI } from '@/modules/sidebar/utils/sessionStatus';

/**
 * The status emoji is shown before a session title in the Projects row, and
 * the picker behind it is driven by the row's own callbacks. The options menu
 * is recorded rather than rendered, so these tests reach its items directly.
 */

const recordedOptionsProps: Record<string, unknown>[] = [];

vi.mock('@/modules/sidebar/SessionOptions', () => ({
  default: (props: Record<string, unknown>) => {
    recordedOptionsProps.push(props);
    return null;
  },
}));

const { default: SidebarSessionItem } = await import('@/modules/sidebar/SidebarSessionItem');

const t = ((key: string) => key) as unknown as SidebarProjectListProps['t'];
const NOW = new Date('2026-08-21T10:00:00.000Z');
const noop = () => {};

const PROJECT = { projectId: 'project-1', name: 'project-1', displayName: 'project one', fullPath: '/tmp/project-1', sessions: [] } as unknown as Project;

const renderRow = (session: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
  const sessionWithProvider = { id: 's1', summary: 'session one', lastActivity: '2026-08-21T09:59:00.000Z', __provider: 'claude', ...session } as unknown as SessionWithProvider;
  return render(
    React.createElement(SidebarSessionItem, {
      project: PROJECT,
      session: sessionWithProvider,
      selectedSession: null,
      isProcessing: false,
      hasBackgroundWork: false,
      needsAttention: false,
      currentTime: NOW,
      isEditing: false,
      renameDraft: '',
      onRenameDraftChange: noop,
      onStartEditingSession: noop,
      onCancelEditingSession: noop,
      onSaveEditingSession: noop,
      onProjectSelect: noop,
      onSessionSelect: noop,
      onDeleteSession: noop,
      isSelecting: false,
      isChecked: false,
      onToggleSessionSelected: noop,
      t,
      ...overrides,
    }),
  );
};

beforeEach(() => {
  recordedOptionsProps.length = 0;
});

afterEach(() => {
  cleanup();
});

test('a session with a status shows its emoji before the title, and the title text has none', () => {
  const { container } = renderRow({ status: 'bug', statusSource: 'auto' });

  assert.ok(screen.getByText(SESSION_STATUS_EMOJI.bug));
  const title = container.querySelector('[title="session one"]');
  assert.equal(title?.textContent, 'session one');
});

test('a session without a status shows no status emoji', () => {
  const { container } = renderRow({ status: null, statusSource: null }, { onSetSessionStatus: noop });

  for (const emoji of Object.values(SESSION_STATUS_EMOJI)) {
    assert.equal(container.textContent?.includes(emoji), false);
  }
  // The desktop row keeps a faint target for opening the picker instead.
  assert.ok(screen.getByRole('button', { name: 'sessionStatus.setStatus' }));
});

test('clicking the emoji opens the picker without opening the session, and a pick pins that status', () => {
  const onSessionSelect = vi.fn();
  const onSetSessionStatus = vi.fn();
  renderRow({ status: 'bug', statusSource: 'auto' }, { onSessionSelect, onSetSessionStatus });

  fireEvent.click(screen.getByText(SESSION_STATUS_EMOJI.bug));

  assert.equal(onSessionSelect.mock.calls.length, 0);
  assert.ok(screen.getByRole('menu'));

  fireEvent.click(screen.getByRole('menuitemradio', { name: /sessionStatus\.done/ }));

  assert.equal(onSetSessionStatus.mock.calls.length, 1);
  assert.equal(onSetSessionStatus.mock.calls[0][0].id, 's1');
  assert.equal(onSetSessionStatus.mock.calls[0][1], 'done');
  assert.equal(screen.queryByRole('menu'), null, 'the picker closes after a pick');
});

test('the Auto entry hands the status back to automatic checks with null', () => {
  const onSetSessionStatus = vi.fn();
  renderRow({ status: 'bug', statusSource: 'user' }, { onSetSessionStatus });

  fireEvent.click(screen.getByRole('button', { name: /sessionStatus\.statusLabel|sessionStatus\.bug|sessionStatus\.setStatus/ }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: /sessionStatus\.auto/ }));

  assert.equal(onSetSessionStatus.mock.calls[0][1], null);
});

test('the Auto rename item runs the row callback and shows a spinner until it settles', async () => {
  let settle: () => void = () => {};
  const onAutoRenameSession = vi.fn((_session: SessionWithProvider) => new Promise<void>((resolve) => {
    settle = resolve;
  }));
  renderRow({ status: null }, { onAutoRenameSession });

  const menuProps = () => recordedOptionsProps.at(-1) as { onAutoRename?: () => void; isAutoRenaming?: boolean };
  assert.equal(typeof menuProps().onAutoRename, 'function');
  assert.equal(menuProps().isAutoRenaming, false);

  act(() => {
    menuProps().onAutoRename?.();
  });

  assert.equal(onAutoRenameSession.mock.calls.length, 1);
  assert.equal(onAutoRenameSession.mock.calls[0][0].id, 's1');
  assert.equal(menuProps().isAutoRenaming, true);

  await act(async () => {
    settle();
  });
  assert.equal(menuProps().isAutoRenaming, false);
});

test('the options menu gets no auto rename or status items when the row has no callbacks', () => {
  renderRow({ status: 'bug' });

  const menuProps = recordedOptionsProps.at(-1) as { onAutoRename?: unknown; onOpenStatusPicker?: unknown };
  assert.equal(menuProps.onAutoRename, undefined);
  assert.equal(menuProps.onOpenStatusPicker, undefined);
});
