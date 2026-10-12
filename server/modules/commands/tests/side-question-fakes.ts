import type { SideQuestionRow, SideQuestionStatus } from '@/modules/database/index.js';

/**
 * An in-memory stand-in for `sideQuestionsDb` with the same return rules: a
 * pending row is the only one that can be answered or failed, and rows come
 * back as copies so a test cannot mutate what the service holds.
 */
export function createMemorySideQuestionStore() {
  const rows: SideQuestionRow[] = [];
  let nextId = 1;

  const settle = (id: number, changes: Partial<SideQuestionRow>): SideQuestionRow | null => {
    const row = rows.find((candidate) => candidate.id === id && candidate.status === 'pending');
    if (!row) {
      return null;
    }
    Object.assign(row, changes);
    return { ...row };
  };

  return {
    rows,
    create(sessionId: string, question: string): SideQuestionRow {
      const row: SideQuestionRow = {
        id: nextId++,
        session_id: sessionId,
        question,
        answer: null,
        status: 'pending' as SideQuestionStatus,
        source: null,
        error: null,
        created_at: new Date().toISOString(),
        answered_at: null,
      };
      rows.push(row);
      return { ...row };
    },
    markAnswered(id: number, answer: string, source: 'live' | 'fork'): SideQuestionRow | null {
      return settle(id, { status: 'answered', answer, source, error: null, answered_at: new Date().toISOString() });
    },
    markFailed(id: number, error: string): SideQuestionRow | null {
      return settle(id, { status: 'failed', error, answered_at: null });
    },
    listBySession(sessionId: string): SideQuestionRow[] {
      return rows.filter((row) => row.session_id === sessionId).map((row) => ({ ...row }));
    },
  };
}

/** Lets the background settle step finish: it runs after `ask` has already returned. */
export const flushBackground = () => new Promise<void>((resolve) => setImmediate(resolve));
