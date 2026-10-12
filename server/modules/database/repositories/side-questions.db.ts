import { getConnection } from '@/modules/database/connection.js';

export type SideQuestionStatus = 'pending' | 'answered' | 'failed';

export type SideQuestionRow = {
  id: number;
  session_id: string;
  question: string;
  answer: string | null;
  status: SideQuestionStatus;
  source: 'live' | 'fork' | null;
  error: string | null;
  created_at: string;
  answered_at: string | null;
};

const COLUMNS =
  'id, session_id, question, answer, status, source, error, created_at, answered_at';

const getById = (id: number): SideQuestionRow =>
  getConnection()
    .prepare(`SELECT ${COLUMNS} FROM side_questions WHERE id = ?`)
    .get(id) as SideQuestionRow;

export const sideQuestionsDb = {
  /** Stores a question as pending and returns the new row. Needs the session row to exist. */
  create(sessionId: string, question: string): SideQuestionRow {
    const result = getConnection()
      .prepare(
        `INSERT INTO side_questions (session_id, question, status, created_at)
         VALUES (?, ?, 'pending', ?)`
      )
      .run(sessionId, question, new Date().toISOString());

    return getById(Number(result.lastInsertRowid));
  },

  /** Records the answer. Only a pending row can be answered; returns null otherwise. */
  markAnswered(id: number, answer: string, source: 'live' | 'fork'): SideQuestionRow | null {
    const result = getConnection()
      .prepare(
        `UPDATE side_questions
         SET status = 'answered', answer = ?, source = ?, error = NULL, answered_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(answer, source, new Date().toISOString(), id);

    return result.changes > 0 ? getById(id) : null;
  },

  /** Records why the question failed. Only a pending row can fail; returns null otherwise. */
  markFailed(id: number, error: string): SideQuestionRow | null {
    const result = getConnection()
      .prepare(
        `UPDATE side_questions
         SET status = 'failed', error = ?, answered_at = NULL
         WHERE id = ? AND status = 'pending'`
      )
      .run(error.slice(0, 500), id);

    return result.changes > 0 ? getById(id) : null;
  },

  /** Every entry of a session, oldest first. */
  listBySession(sessionId: string): SideQuestionRow[] {
    return getConnection()
      .prepare(
        `SELECT ${COLUMNS} FROM side_questions
         WHERE session_id = ?
         ORDER BY id ASC`
      )
      .all(sessionId) as SideQuestionRow[];
  },

  /**
   * Fails every entry still pending. Run at startup: an answer that was in
   * flight when the server stopped can never arrive. Returns how many changed.
   */
  failPending(reason: string): number {
    return getConnection()
      .prepare(
        `UPDATE side_questions
         SET status = 'failed', error = ?, answered_at = NULL
         WHERE status = 'pending'`
      )
      .run(reason.slice(0, 500)).changes;
  },
};
