import { getConnection } from '@/modules/database/connection.js';

export type SessionStatusCheckReason = 'automatic' | 'leaving-blocked' | 'auto-rename';

/** One model call, as written by the title and status service. */
export type SessionStatusCheckInsert = {
  createdAt: string;
  sessionId: string;
  reason: SessionStatusCheckReason;
  ok: boolean;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
};

export type SessionStatusCheckTotals = {
  checks: number;
  automatic: number;
  autoRename: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type SessionStatusCheckDayTotals = {
  day: string;
  checks: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type SessionStatusCheckLast = {
  createdAt: string;
  sessionId: string;
  reason: SessionStatusCheckReason;
  ok: boolean;
  durationMs: number;
};

/** Rows older than this are deleted on insert. */
const RETENTION_DAYS = 90;

/** The reasons that count against the daily automatic limit. */
const AUTOMATIC_REASONS = `('automatic', 'leaving-blocked')`;

export const sessionStatusChecksDb = {
  /** Stores one call and drops rows past the retention window, so the table stays small. */
  insert(row: SessionStatusCheckInsert): void {
    const db = getConnection();
    db.prepare(
      `INSERT INTO session_status_checks
         (created_at, session_id, reason, ok, duration_ms, input_tokens, output_tokens, cost_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      row.createdAt,
      row.sessionId,
      row.reason,
      row.ok ? 1 : 0,
      row.durationMs,
      row.inputTokens,
      row.outputTokens,
      row.costUsd,
    );

    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    db.prepare('DELETE FROM session_status_checks WHERE created_at < ?').run(cutoff);
  },

  /** Automatic and leaving-blocked calls since `sinceIso`. This is what the daily limit counts. */
  countAutomaticSince(sinceIso: string): number {
    const row = getConnection()
      .prepare(
        `SELECT COUNT(*) AS count FROM session_status_checks
         WHERE created_at >= ? AND reason IN ${AUTOMATIC_REASONS}`
      )
      .get(sinceIso) as { count: number };
    return row.count;
  },

  /** Totals of every call since `sinceIso`, split by reason and by ok. */
  totalsSince(sinceIso: string): SessionStatusCheckTotals {
    const row = getConnection()
      .prepare(
        `SELECT
           COUNT(*) AS checks,
           COALESCE(SUM(CASE WHEN reason IN ${AUTOMATIC_REASONS} THEN 1 ELSE 0 END), 0) AS automatic,
           COALESCE(SUM(CASE WHEN reason = 'auto-rename' THEN 1 ELSE 0 END), 0) AS autoRename,
           COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS failed,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM session_status_checks
         WHERE created_at >= ?`
      )
      .get(sinceIso) as SessionStatusCheckTotals;
    return row;
  },

  /** Per local day since `sinceIso` (the server's timezone), days with no calls are absent. */
  dayTotalsSince(sinceIso: string): SessionStatusCheckDayTotals[] {
    return getConnection()
      .prepare(
        `SELECT
           date(created_at, 'localtime') AS day,
           COUNT(*) AS checks,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(cost_usd), 0) AS costUsd
         FROM session_status_checks
         WHERE created_at >= ?
         GROUP BY day`
      )
      .all(sinceIso) as SessionStatusCheckDayTotals[];
  },

  /** The most recent call, or null when none is stored. */
  last(): SessionStatusCheckLast | null {
    const row = getConnection()
      .prepare(
        `SELECT created_at AS createdAt, session_id AS sessionId, reason, ok, duration_ms AS durationMs
         FROM session_status_checks
         ORDER BY id DESC
         LIMIT 1`
      )
      .get() as (Omit<SessionStatusCheckLast, 'ok'> & { ok: number }) | undefined;
    if (!row) {
      return null;
    }
    return { ...row, ok: row.ok === 1 };
  },
};
