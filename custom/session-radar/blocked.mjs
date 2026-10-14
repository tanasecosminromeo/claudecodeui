// Blocked sessions: the server sets sessions.status = 'blocked' when a session's last reply
// asks the user something. Such a session may have no live process, so it is not in the radar's
// `sessions`. This lists them for the needs-input pulse. A module of its own so the query can be
// tested on a temp DB.
import path from 'node:path';

// db: an open node:sqlite handle (or null). liveRows: the radar's own session rows, so a blocked
// session that Claude is working on right now (its live row is busy) is left out.
export function blockedRows(db, liveRows) {
  if (!db) return [];
  let rows;
  try {
    rows = db.prepare(
      'SELECT s.session_id AS id, s.provider_session_id AS providerId, s.custom_name AS name, ' +
      'p.custom_project_name AS projectName, s.project_path AS projectPath ' +
      'FROM sessions s LEFT JOIN projects p ON p.project_path = s.project_path ' +
      "WHERE s.status = 'blocked' AND (s.isArchived IS NULL OR s.isArchived = 0)",
    ).all();
  } catch { return []; } // schema changed upstream (no status column): nothing to show
  const busy = new Set(liveRows.filter((s) => s.state === 'busy')
    .flatMap((s) => [s.sessionId, s.appSessionId]));
  return rows
    .filter((row) => !busy.has(row.providerId || row.id) && !busy.has(row.id))
    .map((row) => {
      const sessionId = row.providerId || row.id;
      return {
        sessionId,
        appSessionId: row.id,
        title: (row.name && row.name.trim()) || sessionId.slice(0, 8),
        project: row.projectName || (row.projectPath ? path.basename(row.projectPath) : null),
      };
    });
}
