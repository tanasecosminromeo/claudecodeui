// GET /tree and the "other agent processes" rows of session-radar's server.
// Kept out of server.mjs (which listens on import) so they can be unit-tested.
import fs from 'node:fs';
import path from 'node:path';
import { livePidsOf, processDetail } from './detail.mjs';
import { maskSecrets } from './mask.mjs';
import { buildTree, isClaudeArgv, liveTree, otherAgentPids, procInfo, topAgentAncestor } from './proctree.mjs';

/**
 * A tree node as the browser gets it: argv and cmd masked. A Claude CLI node also gets fullArgv
 * (masked), which the tooltip shows in place of the short argv.
 */
export function redactNode(n) {
  const argv = maskSecrets(n.argv || '');
  const out = { ...n, argv, cmd: maskSecrets(n.cmd || '') };
  if (isClaudeArgv(n.argv)) out.fullArgv = argv;
  return out;
}

function ownedLive(pid, uid) {
  try { return fs.statSync(`/proc/${pid}`).uid === uid; } catch { return false; }
}

/** { status, body } for GET /tree?sid=<claude session id | pid:<n>>. */
export function treeFor(sid, { sessionsDir, execLog, uid }) {
  if (typeof sid !== 'string' || !sid) return { status: 400, body: { error: 'sid required' } };
  let pids;
  if (sid.startsWith('pid:')) {
    const pid = Number(sid.slice(4));
    pids = Number.isInteger(pid) && pid > 1 && ownedLive(pid, uid) ? [pid] : [];
  } else {
    pids = livePidsOf(sid, sessionsDir);
  }
  const roots = [...new Set(pids.map(topAgentAncestor))].filter((p) => ownedLive(p, uid));
  if (roots.length === 0) return { status: 404, body: { error: 'no live process for that session' } };
  const live = roots.flatMap((p) => liveTree(p));
  const records = execLog.records();
  const tree = buildTree({ rootPids: roots, live, records });
  return { status: 200, body: { now: Date.now(), history: records !== null, ...tree, nodes: tree.nodes.map(redactNode) } };
}

const REGISTER_GRACE_MS = 10000;
// Masked before it is cut, so a secret never reaches the browser half-shown.
const shownTitle = (argv) => { const m = maskSecrets(argv); return m.length > 70 ? `${m.slice(0, 69)}…` : m; };

/**
 * Rows for claude / claude-swap processes that registered no ~/.claude/sessions file.
 * A process younger than REGISTER_GRACE_MS is skipped: Claude Code writes its status file
 * right after start, and listing it as "other" for those seconds would make a new session
 * flicker between groups.
 */
export function otherAgentRows(registeredPids, uid, find = otherAgentPids, now = Date.now) {
  const rows = [];
  for (const pid of find(uid, registeredPids)) {
    const info = procInfo(pid);
    if (!info || now() - info.startMs < REGISTER_GRACE_MS) continue;
    let cwd = null;
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone or not ours */ }
    const d = processDetail(pid);
    rows.push({
      sessionId: `pid:${pid}`, other: true, live: true, state: 'other', waitingFor: null,
      title: shownTitle(info.argv),
      name: null, entrypoint: null, cwd, project: cwd ? path.basename(cwd) : null,
      pids: [pid], tasks: d.commands.length, startedAt: info.startMs, lastMessage: null, lastActivity: info.startMs,
      rssMb: Math.round(d.rssKb / 1024), procs: d.procs, commands: d.commands.slice(0, 5).map(maskSecrets),
      agents: 0, model: null, branch: null, mode: null, contextTokens: null, archived: false, active: true,
    });
  }
  return rows;
}
