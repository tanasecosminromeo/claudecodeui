import { useSyncExternalStore } from 'react';

import type { SideQuestionEntry } from '@/shared/types';

/**
 * Side-question entries per session and the panel's open state. The composer
 * (which asks `/btw`), the workspace title (which shows the count) and the
 * panel all read this one store, so none of them imports the others. Entries
 * are not kept on this side of a reload: the server holds them and the panel
 * refetches on open. Only the open state is persisted.
 */

const OPEN_STORAGE_KEY = 'side-questions-panel-open';

type SideQuestionsState = {
  isOpen: boolean;
  entriesBySession: Record<string, SideQuestionEntry[]>;
  transcriptPathBySession: Record<string, string | null>;
};

const EMPTY_ENTRIES: SideQuestionEntry[] = [];

const readOpenState = (): boolean => {
  try {
    return localStorage.getItem(OPEN_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

const listeners = new Set<() => void>();

let state: SideQuestionsState = {
  isOpen: readOpenState(),
  entriesBySession: {},
  transcriptPathBySession: {},
};

function setState(next: SideQuestionsState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getState = (): SideQuestionsState => state;

export function setSideQuestionsPanelOpen(isOpen: boolean): void {
  if (state.isOpen === isOpen) {
    return;
  }
  try {
    localStorage.setItem(OPEN_STORAGE_KEY, isOpen ? '1' : '0');
  } catch {
    // Without storage the panel still works; it just starts closed on reload.
  }
  setState({ ...state, isOpen });
}

export function toggleSideQuestionsPanel(): void {
  setSideQuestionsPanelOpen(!state.isOpen);
}

/**
 * Replaces a session's list with the server's copy. An entry this client
 * already holds in a settled state (answered or failed) wins over the fetched
 * copy, which may predate the websocket update that settled it.
 */
export function setSideQuestionList(
  sessionId: string,
  entries: SideQuestionEntry[],
  transcriptPath: string | null,
): void {
  const held = state.entriesBySession[sessionId] ?? EMPTY_ENTRIES;
  const heldById = new Map(held.map((entry) => [entry.id, entry]));
  const merged = entries.map((fetched) => {
    const current = heldById.get(fetched.id);
    return current && current.status !== 'pending' ? current : fetched;
  });
  const fetchedIds = new Set(entries.map((entry) => entry.id));
  // Entries that arrived over the websocket after the fetch was sent.
  const extra = held.filter((entry) => !fetchedIds.has(entry.id));

  setState({
    ...state,
    entriesBySession: { ...state.entriesBySession, [sessionId]: [...merged, ...extra] },
    transcriptPathBySession: { ...state.transcriptPathBySession, [sessionId]: transcriptPath },
  });
}

/** Inserts or replaces one entry (by id) in its session's list, keeping oldest first. */
export function upsertSideQuestionEntry(entry: SideQuestionEntry): void {
  const current = state.entriesBySession[entry.sessionId] ?? EMPTY_ENTRIES;
  const index = current.findIndex((item) => item.id === entry.id);
  const next = index === -1
    ? [...current, entry].sort((a, b) => a.id - b.id)
    : current.map((item, position) => (position === index ? entry : item));

  setState({
    ...state,
    entriesBySession: { ...state.entriesBySession, [entry.sessionId]: next },
  });
}

export function useSideQuestionsPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, () => getState().isOpen);
}

export function useSideQuestionEntries(sessionId: string | null): SideQuestionEntry[] {
  return useSyncExternalStore(subscribe, () => (
    sessionId ? getState().entriesBySession[sessionId] ?? EMPTY_ENTRIES : EMPTY_ENTRIES
  ));
}

export function useSideQuestionTranscriptPath(sessionId: string | null): string | null {
  return useSyncExternalStore(subscribe, () => (
    sessionId ? getState().transcriptPathBySession[sessionId] ?? null : null
  ));
}

/** Test helper: returns the store to its initial, closed state. */
export function resetSideQuestionsStore(): void {
  setState({ isOpen: false, entriesBySession: {}, transcriptPathBySession: {} });
}
