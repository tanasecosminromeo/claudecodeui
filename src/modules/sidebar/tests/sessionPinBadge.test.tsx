import { render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, expect, test, vi } from 'vitest';

import type { Project, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * A pinned session shows a small pin badge on its provider logo, and the menu
 * offers Pin or Unpin accordingly. The badge is decoration only: the row keeps
 * its height and its position in the list.
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
const SESSION = { id: 's1', summary: 'session one', lastActivity: '2026-08-21T09:00:00.000Z', __provider: 'claude' } as unknown as SessionWithProvider;

const renderRow = (isPinned: boolean) => render(
  React.createElement(SidebarSessionItem, {
    project: PROJECT,
    session: SESSION,
    selectedSession: null,
    isProcessing: false,
    hasBackgroundWork: false,
    needsAttention: false,
    isPinned,
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
    onTogglePinSession: noop,
    isSelecting: false,
    isChecked: false,
    onToggleSessionSelected: noop,
    t,
  }),
);

beforeEach(() => {
  recordedOptionsProps.length = 0;
});

test('a pinned row shows the pin badge on its provider logo', () => {
  renderRow(true);

  const badge = screen.queryByTitle('Pinned');
  expect(badge).toBeTruthy();
  expect(screen.queryByLabelText('Pinned')).toBeTruthy();
  // The badge sits inside the logo box, which is the positioned ancestor.
  expect(badge?.parentElement?.className.includes('relative')).toBeTruthy();
  expect(recordedOptionsProps.at(-1)?.isPinned).toBe(true);
});

test('an unpinned row has no pin badge and offers Pin', () => {
  renderRow(false);

  expect(screen.queryByTitle('Pinned')).toBeNull();
  expect(recordedOptionsProps.at(-1)?.isPinned).toBe(false);
  expect(typeof recordedOptionsProps.at(-1)?.onTogglePin).toBe('function');
});
