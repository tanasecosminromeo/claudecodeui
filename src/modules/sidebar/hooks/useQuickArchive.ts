import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/shared/api';
import type { ProjectSession, QuickArchiveNotice, SessionWithProvider } from '@/shared/types';

/** How long a notice offers Undo before it dismisses itself. */
const QUICK_ARCHIVE_UNDO_WINDOW_MS = 8000;
/** Notices shown at once; a burst of archives drops the oldest rather than stacking up the screen. */
const QUICK_ARCHIVE_MAX_NOTICES = 3;

type UseQuickArchiveArgs = {
  /** The session open in the workspace, so Undo knows whether to reopen it. */
  selectedSessionId: string | null;
  /** Runs once the server has archived the session; the caller drops it from its lists. */
  onArchived: (sessionId: string) => void;
  /** Runs once the server has restored the session; the caller reloads its lists and, when `reopen`, navigates back to it. */
  onRestored: (session: SessionWithProvider, reopen: boolean) => void;
};

/**
 * The quick-archive flow: archive one session with a single call, keep a
 * short-lived notice offering Undo, and restore it through the same API the
 * Archive tab uses. Both directions are real server round trips — nothing is
 * archived optimistically, so a notice only ever exists for a session the
 * server has hidden.
 */
export function useQuickArchive({ selectedSessionId, onArchived, onRestored }: UseQuickArchiveArgs) {
  // The archives still offering Undo, oldest first. Each entry is what the
  // undo needs: the session to restore and whether to reopen it.
  const [notices, setNotices] = useState<QuickArchiveNotice[]>([]);
  // One dismiss timer per notice, cleared on undo, dismiss and unmount.
  const dismissTimersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const noticeSequenceRef = useRef(0);

  const dismissNotice = useCallback((noticeId: number) => {
    const timer = dismissTimersRef.current.get(noticeId);
    if (timer !== undefined) {
      clearTimeout(timer);
      dismissTimersRef.current.delete(noticeId);
    }
    setNotices((previous) => (
      previous.some((notice) => notice.id === noticeId)
        ? previous.filter((notice) => notice.id !== noticeId)
        : previous
    ));
  }, []);

  useEffect(() => {
    const timers = dismissTimersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  /** Archives the session; resolves false (and shows nothing) when the server refused. */
  const archiveSession = useCallback(async (session: ProjectSession, title: string): Promise<boolean> => {
    try {
      const response = await api.deleteSession(session.id, false);
      if (!response.ok) {
        console.error('[Sidebar] Failed to archive session:', {
          status: response.status,
          error: await response.text(),
        });
        return false;
      }
    } catch (error) {
      console.error('[Sidebar] Error archiving session:', error);
      return false;
    }

    // Read before `onArchived`, which closes the open session.
    const wasOpen = selectedSessionId === session.id;
    onArchived(session.id);

    const noticeId = (noticeSequenceRef.current += 1);
    const notice: QuickArchiveNotice = {
      id: noticeId,
      session: { ...session, __provider: session.__provider ?? session.provider ?? 'claude' },
      title,
      wasOpen,
    };
    // A notice dropped by the cap keeps its timer; it fires on an id that is
    // no longer listed, which dismissNotice treats as a no-op.
    setNotices((previous) => [...previous, notice].slice(-QUICK_ARCHIVE_MAX_NOTICES));
    dismissTimersRef.current.set(
      noticeId,
      setTimeout(() => dismissNotice(noticeId), QUICK_ARCHIVE_UNDO_WINDOW_MS),
    );
    return true;
  }, [dismissNotice, onArchived, selectedSessionId]);

  /** Restores the notice's session; resolves false and keeps the notice (so the user can retry) when the server refused. */
  const undoArchive = useCallback(async (noticeId: number): Promise<boolean> => {
    const notice = notices.find((candidate) => candidate.id === noticeId);
    if (!notice) {
      return true;
    }

    try {
      const response = await api.restoreSession(notice.session.id);
      if (!response.ok) {
        console.error('[Sidebar] Failed to restore session:', {
          status: response.status,
          error: await response.text(),
        });
        return false;
      }
    } catch (error) {
      console.error('[Sidebar] Error restoring session:', error);
      return false;
    }

    dismissNotice(noticeId);
    onRestored(notice.session, notice.wasOpen);
    return true;
  }, [dismissNotice, notices, onRestored]);

  return {
    notices,
    archiveSession,
    undoArchive,
    dismissNotice,
  };
}
