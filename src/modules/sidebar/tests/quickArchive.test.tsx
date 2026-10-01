import assert from 'node:assert/strict';

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { QuickArchiveNotice, SessionWithProvider, SidebarProjectListProps } from '@/shared/types';

/**
 * The quick archive: one call archives a session on the server, a notice
 * offers Undo for a few seconds, and Undo restores it through the server and
 * reopens it when it was the open session. Every step that changes what the
 * user sees is asserted here against a stubbed API.
 */

const deleteSession = vi.fn();
const restoreSession = vi.fn();

vi.mock('@/shared/api', () => ({
  api: {
    deleteSession: (...args: unknown[]) => deleteSession(...args),
    restoreSession: (...args: unknown[]) => restoreSession(...args),
    providerSessionId: () => Promise.resolve({ ok: false }),
  },
}));

// SessionOptions asks the capability matrix which providers can fork; the
// request is irrelevant here.
vi.mock('@/shared/hooks/useProviderCapabilities', () => ({
  useSessionForkingProviders: () => new Set<string>(),
}));

const { useQuickArchive } = await import('@/modules/sidebar/hooks/useQuickArchive');
const { default: QuickArchiveNotices } = await import('@/modules/sidebar/QuickArchiveNotices');
const { default: SessionOptions } = await import('@/modules/sidebar/SessionOptions');

const t = ((key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key)) as unknown as SidebarProjectListProps['t'];
const noop = () => {};

const session = (id: string): SessionWithProvider => ({
  id,
  summary: `title of ${id}`,
  __provider: 'claude',
  __projectId: 'project-1',
});

const ok = () => Promise.resolve({ ok: true, text: async () => '' });
const refused = () => Promise.resolve({ ok: false, status: 500, text: async () => 'nope' });

const renderQuickArchive = (selectedSessionId: string | null) => {
  const onArchived = vi.fn();
  const onRestored = vi.fn();
  const hook = renderHook(() => useQuickArchive({ selectedSessionId, onArchived, onRestored }));
  return { ...hook, onArchived, onRestored };
};

beforeEach(() => {
  deleteSession.mockReset();
  restoreSession.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('archiving calls the archive API, drops the session and shows a notice that remembers it was open', async () => {
  deleteSession.mockImplementation(ok);
  const { result, onArchived } = renderQuickArchive('s1');

  let archived = false;
  await act(async () => {
    archived = await result.current.archiveSession(session('s1'), 'title of s1');
  });

  assert.equal(archived, true);
  assert.deepEqual(deleteSession.mock.calls, [['s1', false]], 'archive only, never a hard delete');
  assert.deepEqual(onArchived.mock.calls, [['s1']]);
  assert.equal(result.current.notices.length, 1);
  assert.equal(result.current.notices[0].title, 'title of s1');
  assert.equal(result.current.notices[0].wasOpen, true);
});

test('a session that was not open is archived without asking Undo to reopen it', async () => {
  deleteSession.mockImplementation(ok);
  restoreSession.mockImplementation(ok);
  const { result, onRestored } = renderQuickArchive('other');

  await act(async () => {
    await result.current.archiveSession(session('s1'), 'title of s1');
  });
  assert.equal(result.current.notices[0].wasOpen, false);

  await act(async () => {
    await result.current.undoArchive(result.current.notices[0].id);
  });
  assert.equal(onRestored.mock.calls[0][1], false);
});

test('Undo restores through the server, removes the notice and reopens the session', async () => {
  deleteSession.mockImplementation(ok);
  restoreSession.mockImplementation(ok);
  const { result, onRestored } = renderQuickArchive('s1');

  await act(async () => {
    await result.current.archiveSession(session('s1'), 'title of s1');
  });
  const noticeId = result.current.notices[0].id;

  let restored = false;
  await act(async () => {
    restored = await result.current.undoArchive(noticeId);
  });

  assert.equal(restored, true);
  assert.deepEqual(restoreSession.mock.calls, [['s1']]);
  assert.equal(result.current.notices.length, 0);
  assert.equal(onRestored.mock.calls.length, 1);
  assert.equal(onRestored.mock.calls[0][0].id, 's1');
  assert.equal(onRestored.mock.calls[0][0].__provider, 'claude');
  assert.equal(onRestored.mock.calls[0][1], true, 'reopened because it was the open session');

  // The dismiss timer was cleared with the notice: nothing fires later.
  act(() => {
    vi.advanceTimersByTime(20000);
  });
  assert.equal(result.current.notices.length, 0);
});

test('a notice dismisses itself after the undo window without touching the server', async () => {
  deleteSession.mockImplementation(ok);
  const { result, onRestored } = renderQuickArchive(null);

  await act(async () => {
    await result.current.archiveSession(session('s1'), 'title of s1');
  });
  assert.equal(result.current.notices.length, 1);

  act(() => {
    vi.advanceTimersByTime(7900);
  });
  assert.equal(result.current.notices.length, 1, 'still offered just before the window ends');

  act(() => {
    vi.advanceTimersByTime(200);
  });
  assert.equal(result.current.notices.length, 0);
  assert.equal(restoreSession.mock.calls.length, 0);
  assert.equal(onRestored.mock.calls.length, 0);
});

test('a refused archive shows no notice and drops nothing', async () => {
  deleteSession.mockImplementation(refused);
  const { result, onArchived } = renderQuickArchive('s1');
  const consoleError = vi.spyOn(console, 'error').mockImplementation(noop);

  let archived = true;
  await act(async () => {
    archived = await result.current.archiveSession(session('s1'), 'title of s1');
  });

  assert.equal(archived, false);
  assert.equal(result.current.notices.length, 0);
  assert.equal(onArchived.mock.calls.length, 0);
  consoleError.mockRestore();
});

test('a refused Undo keeps the notice so the user can try again', async () => {
  deleteSession.mockImplementation(ok);
  restoreSession.mockImplementation(refused);
  const { result, onRestored } = renderQuickArchive('s1');
  const consoleError = vi.spyOn(console, 'error').mockImplementation(noop);

  await act(async () => {
    await result.current.archiveSession(session('s1'), 'title of s1');
  });

  let restored = true;
  await act(async () => {
    restored = await result.current.undoArchive(result.current.notices[0].id);
  });

  assert.equal(restored, false);
  assert.equal(result.current.notices.length, 1);
  assert.equal(onRestored.mock.calls.length, 0);
  consoleError.mockRestore();
});

test('a burst of archives keeps only the newest three notices, and each still undoes its own session', async () => {
  deleteSession.mockImplementation(ok);
  restoreSession.mockImplementation(ok);
  const { result } = renderQuickArchive(null);

  for (const id of ['s1', 's2', 's3', 's4']) {
    await act(async () => {
      await result.current.archiveSession(session(id), `title of ${id}`);
    });
  }

  assert.deepEqual(result.current.notices.map((notice) => notice.session.id), ['s2', 's3', 's4']);

  await act(async () => {
    await result.current.undoArchive(result.current.notices[1].id);
  });
  assert.deepEqual(restoreSession.mock.calls, [['s3']]);
  assert.deepEqual(result.current.notices.map((notice) => notice.session.id), ['s2', 's4']);
});

test('dismissing a notice removes it without restoring anything', async () => {
  deleteSession.mockImplementation(ok);
  const { result } = renderQuickArchive(null);

  await act(async () => {
    await result.current.archiveSession(session('s1'), 'title of s1');
  });
  act(() => {
    result.current.dismissNotice(result.current.notices[0].id);
  });

  assert.equal(result.current.notices.length, 0);
  assert.equal(restoreSession.mock.calls.length, 0);
});

test('the notice names the archived session and its buttons undo or dismiss that notice', () => {
  const notices: QuickArchiveNotice[] = [
    { id: 7, session: session('s1'), title: 'title of s1', wasOpen: true },
    { id: 8, session: session('s2'), title: 'title of s2', wasOpen: false },
  ];
  const onUndo = vi.fn();
  const onDismiss = vi.fn();
  render(<QuickArchiveNotices notices={notices} onUndo={onUndo} onDismiss={onDismiss} t={t} />);

  const rendered = screen.getAllByTestId('quick-archive-notice');
  assert.equal(rendered.length, 2);
  assert.match(rendered[0].textContent ?? '', /Archived title of s1/);
  assert.match(rendered[1].textContent ?? '', /Archived title of s2/);

  fireEvent.click(screen.getAllByRole('button', { name: 'Undo' })[0]);
  assert.deepEqual(onUndo.mock.calls, [[7]]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[1]);
  assert.deepEqual(onDismiss.mock.calls, [[8]]);
});

test('no notices renders nothing', () => {
  render(<QuickArchiveNotices notices={[]} onUndo={noop} onDismiss={noop} t={t} />);
  assert.equal(screen.queryAllByTestId('quick-archive-notice').length, 0);
});

const renderOptions = (props: { onArchive?: () => void; isProcessing?: boolean }) => render(
  <SessionOptions
    sessionId="s1"
    sessionName="title of s1"
    provider="claude"
    projectId="project-1"
    isProcessing={props.isProcessing ?? false}
    isEditing={false}
    renameDraft=""
    onRenameDraftChange={noop}
    onStartEditingSession={noop}
    onCancelEditingSession={noop}
    onSaveEditingSession={noop}
    onDeleteSession={noop}
    onArchive={props.onArchive}
    t={t}
  />,
);

test('the row offers a one-click archive named after the session', () => {
  const onArchive = vi.fn();
  renderOptions({ onArchive });

  const button = screen.getByRole('button', { name: 'Archive session: title of s1' });
  fireEvent.click(button);
  assert.equal(onArchive.mock.calls.length, 1);
});

test('the archive control is withheld while the session is processing, and when the row has nowhere to send it', () => {
  renderOptions({ onArchive: noop, isProcessing: true });
  assert.equal(screen.queryByRole('button', { name: /^Archive session/ }), null);

  renderOptions({});
  assert.equal(screen.queryByRole('button', { name: /^Archive session/ }), null);
});
