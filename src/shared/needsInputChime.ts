import { playNotificationSound } from '@/shared/utils';

/** A live chime this recent suppresses the radar chime for the same session. */
const LIVE_CHIME_WINDOW_MS = 30_000;

/** Session id -> time of its last live chime (`noteNeedsInputChime`). */
const liveChimes = new Map<string, number>();

let stopWatcher: (() => void) | null = null;

/**
 * Chimes for a live `permission_request` and remembers the session, so the radar
 * does not chime again for the same prompt a few seconds later.
 */
export function noteNeedsInputChime(sessionId: string): void {
  liveChimes.set(sessionId, Date.now());
  void playNotificationSound();
}

const toIdList = (ids: unknown): string[] =>
  Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];

const pruneLiveChimes = (now: number): void => {
  for (const [id, chimedAt] of liveChimes) {
    if (now - chimedAt >= LIVE_CHIME_WINDOW_MS) {
      liveChimes.delete(id);
    }
  }
};

/**
 * Starts the radar watcher once: chimes when a session newly appears in the
 * published `waiting` ids. The first state seen is only a baseline, so loading the
 * page or opening a chat never chimes. Returns the stop function; calling start
 * again while running returns a no-op.
 */
export function startNeedsInputChime(): () => void {
  if (stopWatcher) {
    return () => {};
  }

  let previousWaiting: Set<string> | null = null;

  const published = (window as Window & { __uicSessionStates?: { waiting?: unknown } }).__uicSessionStates;
  if (published) {
    previousWaiting = new Set(toIdList(published.waiting));
  }

  const onWaiting = (event: Event) => {
    const detail = (event as CustomEvent<{ waiting?: unknown } | undefined>).detail;
    if (!detail || !Array.isArray(detail.waiting)) {
      return;
    }

    const waiting = new Set(toIdList(detail.waiting));
    const before = previousWaiting;
    previousWaiting = waiting;
    if (!before) {
      return;
    }

    const now = Date.now();
    pruneLiveChimes(now);

    let shouldChime = false;
    for (const id of waiting) {
      if (before.has(id)) {
        continue;
      }
      const chimedAt = liveChimes.get(id);
      if (chimedAt !== undefined && now - chimedAt < LIVE_CHIME_WINDOW_MS) {
        continue;
      }
      shouldChime = true;
    }

    // Several sessions in one update still make a single chime.
    if (shouldChime) {
      void playNotificationSound();
    }
  };

  window.addEventListener('uic:waiting', onWaiting);
  stopWatcher = () => {
    window.removeEventListener('uic:waiting', onWaiting);
    stopWatcher = null;
  };
  return stopWatcher;
}
