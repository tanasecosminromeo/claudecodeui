// GET /tree and the "other agent processes" rows of session-radar's server.
// Kept out of server.mjs (which listens on import) so they can be unit-tested.
import fs from 'node:fs';
import path from 'node:path';
import { livePidsOf, processDetail } from './detail.mjs';
import { buildTree, liveTree, otherAgentPids, procInfo, topAgentAncestor } from './proctree.mjs';

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
  return { status: 200, body: { now: Date.now(), history: records !== null, ...tree } };
}

/** Rows for claude / claude-swap processes that registered no ~/.claude/sessions file. */
export function otherAgentRows(registeredPids, uid, find = otherAgentPids) {
  const rows = [];
  for (const pid of find(uid, registeredPids)) {
    const info = procInfo(pid);
    if (!info) continue;
    let cwd = null;
    try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* gone or not ours */ }
    const d = processDetail(pid);
    rows.push({
      sessionId: `pid:${pid}`, other: true, live: true, state: 'other', waitingFor: null,
      title: info.argv.length > 70 ? `${info.argv.slice(0, 69)}…` : info.argv,
      name: null, entrypoint: null, cwd, project: cwd ? path.basename(cwd) : null,
      pids: [pid], tasks: d.commands.length, startedAt: info.startMs, lastMessage: null, lastActivity: info.startMs,
      rssMb: Math.round(d.rssKb / 1024), procs: d.procs, commands: d.commands.slice(0, 5),
      agents: 0, model: null, branch: null, mode: null, contextTokens: null, archived: false, active: true,
    });
  }
  return rows;
}
