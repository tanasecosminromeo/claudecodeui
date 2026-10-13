// GET /process?pid=N&procStart=S: everything the radar knows about one process, for the process
// modal. Read-only. Every root is injectable (proc, cgroup, records dir, exec log) so tests run on
// fixtures. Command lines are masked here; nothing unmasked leaves this module.
import fs from 'node:fs';
import path from 'node:path';
import { maskSecrets } from './mask.mjs';
import { UNIT_RE, defaultCgroupRoot, defaultRecordsDir, listLeftovers, liveRecordUnits, readProc } from './leftovers.mjs';
import { commandLabel } from './proctree.mjs';

const CLK_TCK = 100;
export const HISTORY_MAX = 50;
const CHILDREN_MAX = 200;
const SUBTREE_MAX = 500;
const SLACK_MS = 1000; // records are stamped by the tracer a moment after the process started

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

/** The cgroup path's last part, when the process is in a unit (cgroup v2 "0::" line), else null. */
function unitOf(procRoot, pid) {
  const line = (readText(path.join(procRoot, String(pid), 'cgroup')) || '').split('\n').find((l) => l.startsWith('0::'));
  if (!line) return null;
  const base = path.basename(line.slice(3).trim());
  return base || null;
}

/**
 * What kind of scope a unit is: a live session (its record still runs), a leftover (listed by
 * the leftovers route, so it can be killed), the CloudCLI service itself, or something else.
 */
export function classifyScope(unit, { procRoot, cgroupRoot, recordsDir, now }) {
  if (!unit) return { unit: null, kind: 'none' };
  const m = unit.match(UNIT_RE);
  if (m) {
    if (liveRecordUnits(recordsDir, procRoot).has(unit)) return { unit, kind: 'session', appSessionId: m[1] };
    const listed = listLeftovers({ cgroupRoot, recordsDir, procRoot, now }).some((g) => g.unit === unit);
    return { unit, kind: listed ? 'leftover' : 'scope', appSessionId: m[1] };
  }
  if (/^cloudcli.*\.service$/.test(unit)) return { unit, kind: 'service' };
  return { unit, kind: 'other' };
}

/** Direct children of pid (their /task/<tid>/children files, as detail.mjs reads them). */
function childPids(procRoot, pid) {
  let tasks = [];
  try { tasks = fs.readdirSync(path.join(procRoot, String(pid), 'task')); } catch { return []; }
  const out = [];
  for (const t of tasks) {
    const kids = (readText(path.join(procRoot, String(pid), 'task', t, 'children')) || '').trim().split(/\s+/).filter(Boolean);
    out.push(...kids.map(Number).filter((n) => Number.isInteger(n) && n > 0));
  }
  return [...new Set(out)];
}

/** The pid and every descendant that is alive now (bounded). */
function liveSubtree(procRoot, pid) {
  const out = [pid];
  for (let i = 0; i < out.length && out.length < SUBTREE_MAX; i += 1) {
    for (const c of childPids(procRoot, out[i])) if (!out.includes(c)) out.push(c);
  }
  return out;
}

/** The fields of /proc/<pid>/stat this module needs beyond readProc: state, cpu ticks. */
function statExtra(procRoot, pid) {
  const stat = readText(path.join(procRoot, String(pid), 'stat')) || '';
  const close = stat.lastIndexOf(')');
  const f = stat.slice(close + 2).trim().split(' ');
  return { state: f[0] || null, cpuTicks: (Number(f[11]) || 0) + (Number(f[12]) || 0) };
}

/** Threads from /proc/<pid>/status. */
function threadsOf(procRoot, pid) {
  const m = (readText(path.join(procRoot, String(pid), 'status')) || '').match(/^Threads:\s+(\d+)/m);
  return m ? Number(m[1]) : null;
}

/**
 * Exec history of a subtree: the logged execs of `pids` and of their logged descendants, newest
 * first, each with its exit when one was logged. Only records from the process's own lifetime count
 * (a reused pid's older records are dropped).
 */
export function historyOf(records, pids, startedAt) {
  const set = new Set(pids);
  const recs = [...records].sort((a, b) => a.ts - b.ts);
  // Logged descendants: an exec whose parent (or logged ancestor) is already in the set.
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of recs) {
      if (r.ev !== 'exec' || set.has(r.pid)) continue;
      if (set.has(r.ppid) || set.has(r.lparent)) { set.add(r.pid); grew = true; }
    }
  }
  const open = new Map(); // pid -> entry still waiting for its exit record
  const out = [];
  for (const r of recs) {
    if (r.ts < startedAt - SLACK_MS || !set.has(r.pid)) continue;
    if (r.ev === 'exec') {
      const entry = {
        ts: r.ts, pid: r.pid, cmd: showCmd(r.argv), endMs: null, code: null, sig: null,
      };
      open.set(r.pid, entry);
      out.push(entry);
    } else if (r.ev === 'exit' && open.has(r.pid)) {
      const entry = open.get(r.pid);
      entry.endMs = r.ts; entry.code = r.code ?? null; entry.sig = r.sig || null;
      open.delete(r.pid);
    }
  }
  return out.reverse().map((e) => ({ ...e, status: statusOf(e) }));
}

function showCmd(argv) {
  const text = maskSecrets(commandLabel(String(argv || ''), String(argv || '')));
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

function statusOf(e) {
  if (e.endMs == null) return 'no exit recorded';
  if (e.sig) return `killed by signal ${e.sig}`;
  return `exit ${e.code}`;
}

/**
 * { status, body } for GET /process. Order of checks: pid gone or procStart changed (404), not
 * owned by the caller's uid (403). A reused pid (different start time) is never described.
 */
export function processFor({ pid, procStart }, deps = {}) {
  const {
    procRoot = '/proc', uid = process.getuid(), now = Date.now(), execLog = null,
    cgroupRoot = defaultCgroupRoot(uid), recordsDir = defaultRecordsDir(),
  } = deps;
  if (!Number.isInteger(pid) || pid <= 1 || typeof procStart !== 'string' || !/^\d+$/.test(procStart)) {
    return { status: 400, body: { error: 'pid and procStart required' } };
  }
  const info = readProc(pid, procRoot);
  if (!info || info.procStart !== procStart) return { status: 404, body: { error: 'no such process (it ended or the pid was reused)' } };
  let owner = null;
  try { owner = fs.statSync(path.join(procRoot, String(pid))).uid; } catch { return { status: 404, body: { error: 'no such process' } }; }
  if (owner !== uid) return { status: 403, body: { error: 'not your process' } };

  const extra = statExtra(procRoot, pid);
  const cpuSec = extra.cpuTicks / CLK_TCK;
  const ageMs = Math.max(0, now - info.startedAt);
  const scope = classifyScope(unitOf(procRoot, pid), { procRoot, cgroupRoot, recordsDir, now });
  let cwd = null;
  try { cwd = fs.readlinkSync(path.join(procRoot, String(pid), 'cwd')); } catch { /* gone or not ours */ }

  const children = [];
  for (const c of childPids(procRoot, pid).slice(0, CHILDREN_MAX)) {
    const k = readProc(c, procRoot);
    if (k) children.push({ pid: c, procStart: k.procStart, name: k.name, command: maskSecrets(k.command) });
  }

  const records = execLog ? execLog.records() : null;
  const history = records ? historyOf(records, liveSubtree(procRoot, pid), info.startedAt) : [];

  return {
    status: 200,
    body: {
      now,
      pid,
      procStart,
      name: info.name,
      ppid: info.ppid,
      command: maskSecrets(info.command),
      cwd: cwd ? maskSecrets(cwd) : null,
      startedAt: info.startedAt,
      ageMs,
      state: extra.state,
      threads: threadsOf(procRoot, pid),
      rssBytes: info.rssBytes,
      cpu: { seconds: Math.round(cpuSec * 10) / 10, percent: ageMs > 0 ? Math.round((cpuSec / (ageMs / 1000)) * 1000) / 10 : null },
      scope,
      killable: scope.kind === 'leftover',
      children,
      history: history.slice(0, HISTORY_MAX),
      historyTotal: history.length,
      historyAvailable: records !== null,
    },
  };
}
