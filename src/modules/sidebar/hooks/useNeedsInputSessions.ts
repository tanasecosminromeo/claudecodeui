import { useEffect, useState } from 'react';

/**
 * Session ids (the ids the sidebar routes on) that a live CLI is waiting on, or
 * is busy with. Published by the ui-cleanup script from the Session Radar.
 */
export type SessionStates = {
  waiting: ReadonlySet<string>;
  busy: ReadonlySet<string>;
};

type PublishedStates = { waiting?: unknown; busy?: unknown };

const EMPTY_STATES: SessionStates = { waiting: new Set(), busy: new Set() };

const toIdSet = (ids: unknown): Set<string> =>
  new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []);

const readPublishedStates = (): SessionStates => {
  const published = (window as Window & { __uicSessionStates?: PublishedStates }).__uicSessionStates;
  return published ? { waiting: toIdSet(published.waiting), busy: toIdSet(published.busy) } : EMPTY_STATES;
};

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every((id) => b.has(id));

const sameStates = (a: SessionStates, b: SessionStates): boolean =>
  sameIds(a.waiting, b.waiting) && sameIds(a.busy, b.busy);

/**
 * Which sessions have a live CLI waiting on the user. Reads the last published
 * state at mount, then follows `uic:waiting`. Returns the same object until the
 * ids change, so a row does not re-render on unrelated events.
 */
export function useNeedsInputSessions(): SessionStates {
  const [states, setStates] = useState<SessionStates>(readPublishedStates);

  useEffect(() => {
    // The script can publish between the first render and this effect.
    setStates((prev) => {
      const next = readPublishedStates();
      return sameStates(prev, next) ? prev : next;
    });

    const onWaiting = (event: Event) => {
      const detail = (event as CustomEvent<PublishedStates | undefined>).detail;
      const next: SessionStates = { waiting: toIdSet(detail?.waiting), busy: toIdSet(detail?.busy) };
      setStates((prev) => (sameStates(prev, next) ? prev : next));
    };
    window.addEventListener('uic:waiting', onWaiting);
    return () => window.removeEventListener('uic:waiting', onWaiting);
  }, []);

  return states;
}

/**
 * True when the session needs the user: a live CLI is waiting on it, or its
 * last reply was marked blocked. A blocked status is stale while Claude is busy
 * on the user's answer, so a busy session does not show the marker from it.
 */
export function sessionNeedsInput(
  session: { id: string; status?: string | null },
  states: SessionStates,
): boolean {
  if (states.waiting.has(session.id)) {
    return true;
  }
  return session.status === 'blocked' && !states.busy.has(session.id);
}
