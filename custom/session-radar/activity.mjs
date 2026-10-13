// What a running session is doing right now, for the lines under its Running-view row:
//  - background sub agents and background tasks still running (from the transcript tail),
//  - the command of the Bash tool's current shell (from the live process tree),
//  - the last distinct commands the exec tracer saw for the session (last 2 minutes).
// Deterministic; everything shown is masked, then shortened, before it leaves the server.
import { maskSecrets } from './mask.mjs';
import { commandLabel, isClaudeArgv } from './proctree.mjs';

export const RECENT_MS = 2 * 60 * 1000;
export const RECENT_MAX = 3;
const MAX_TEXT = 120;
const MAX_CMD = 80;

/** Masked first, then shortened: a secret is never cut in half and left readable. */
export function showText(text, max = MAX_TEXT) {
  const t = maskSecrets(String(text || '')).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** The command of the youngest Bash-tool shell (highest pid), or null when none runs. */
export function currentCommand(shells) {
  if (!shells || shells.length === 0) return null;
  const youngest = shells.reduce((a, b) => (b.pid > a.pid ? b : a));
  return showText(youngest.cmd, MAX_CMD) || null;
}

/**
 * Distinct commands the tracer logged for the session's roots within `windowMs`, newest first.
 * `records` is in time order (ExecLog keeps it so), so the scan stops at the window's edge.
 * Claude CLI starts (nested runs) are left out: they are not commands the session ran.
 */
export function recentCommands(records, roots, now, { windowMs = RECENT_MS, max = RECENT_MAX } = {}) {
  const rootSet = new Set(roots);
  const out = [];
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r.ts < now - windowMs) break;
    if (r.ev !== 'exec' || !rootSet.has(r.root) || isClaudeArgv(r.argv)) continue;
    const cmd = showText(commandLabel(r.argv || '', r.argv || ''), MAX_CMD);
    if (!cmd || out.includes(cmd)) continue;
    out.push(cmd);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * The activity of one live session.
 * running: transcript items still in progress ({ kind: 'agent' | 'task', description, startedAt });
 * shells: the Bash-tool shells of its tree ({ pid, cmd }); records: exec log or null (no tracer);
 * roots: the session's agent pids (the exec log's root field).
 */
export function sessionActivity({ running = [], shells = [], records = null, roots = [], now = Date.now() }) {
  const item = (r) => ({ description: showText(r.description), startedAt: r.startedAt || null });
  return {
    agents: running.filter((r) => r.kind === 'agent').map(item),
    tasks: running.filter((r) => r.kind === 'task').map(item),
    current: currentCommand(shells),
    recent: records ? recentCommands(records, roots, now) : [],
  };
}
