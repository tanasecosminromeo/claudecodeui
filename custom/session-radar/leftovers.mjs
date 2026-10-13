// Leftover processes: processes still running in a CloudCLI scope after the Claude
// session that started them has ended (setsid / nohup jobs, dev servers, tunnels).
// CloudCLI runs each Claude CLI in its own transient scope
// (cloudcli-claude-<appSessionId>-<6 random chars>.scope); when a session's Claude
// exits the scope lives on as long as any child does. Deterministic, no AI.
// Every path is injectable so tests run against fixtures.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskSecrets } from './mask.mjs';

export const UNIT_RE = /^cloudcli-claude-(.+)-([A-Za-z0-9]{6})\.scope$/;
const CLK_TCK = 100;
const KILL_GRACE_MS = 5000;
const MAX_DEPTH = 20;

export function defaultCgroupRoot(uid = process.getuid()) {
  return `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/app.slice`;
}
export function defaultRecordsDir() {
  return path.join(os.homedir(), '.cloudcli', 'claude-processes');
}

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

const scopeName = (unit) => (String(unit).endsWith('.scope') ? String(unit) : `${unit}.scope`);

/** Boot time in ms (the /proc/stat btime line), or an estimate from uptime when it is missing. */
function bootMs(procRoot) {
  const m = (readText(path.join(procRoot, 'stat')) || '').match(/^btime (\d+)/m);
  return m ? Number(m[1]) * 1000 : Date.now() - os.uptime() * 1000;
}

/** { ppid, procStart, startedAt, command, name, rssBytes } of a pid, or null when it is gone. */
export function readProc(pid, procRoot = '/proc', boot) {
  const base = path.join(procRoot, String(pid));
  const stat = readText(path.join(base, 'stat'));
  if (!stat) return null;
  // comm (field 2) may contain spaces: split after the closing ')'
  const close = stat.lastIndexOf(')');
  const comm = stat.slice(stat.indexOf('(') + 1, close);
  const f = stat.slice(close + 2).trim().split(' '); // f[0] = state (field 3)
  const procStart = f[19]; // field 22
  const argv = (readText(path.join(base, 'cmdline')) || '').split('\0').filter(Boolean);
  const rss = (readText(path.join(base, 'status')) || '').match(/^VmRSS:\s+(\d+)\s+kB/m);
  return {
    ppid: Number(f[1]),
    procStart,
    startedAt: (boot ?? bootMs(procRoot)) + Math.round((Number(procStart) / CLK_TCK) * 1000),
    command: argv.join(' ') || `[${comm}]`,
    name: argv.length ? path.basename(argv[0]) : comm,
    rssBytes: rss ? Number(rss[1]) * 1024 : 0,
  };
}

/** Pids of a cgroup and of all its child cgroups (cgroup.procs, recursively). */
export function cgroupPids(dir, depth = 0) {
  const pids = (readText(path.join(dir, 'cgroup.procs')) || '')
    .split('\n').filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (depth >= MAX_DEPTH) return pids;
  let kids = [];
  try { kids = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return pids; }
  for (const d of kids) pids.push(...cgroupPids(path.join(dir, d.name), depth + 1));
  return pids;
}

/** Live records (the pid still runs with the recorded start time), keyed by their scope name. */
export function liveRecordUnits(recordsDir, procRoot = '/proc') {
  const units = new Set();
  let dirs = [];
  try { dirs = fs.readdirSync(recordsDir); } catch { return units; }
  for (const d of dirs) {
    let rec;
    try { rec = JSON.parse(fs.readFileSync(path.join(recordsDir, d, 'record.json'), 'utf8')); } catch { continue; }
    if (!rec || !rec.unit || !rec.pid) continue;
    const p = readProc(rec.pid, procRoot);
    // record.unit is written without the ".scope" suffix that the cgroup directory carries
    if (p && rec.procStart != null && String(rec.procStart) === p.procStart) units.add(scopeName(rec.unit));
  }
  return units;
}

/** Processes as a tree: parents before their children, depth for indentation, siblings oldest first. */
export function treeOrder(procs) {
  const pids = new Set(procs.map((p) => p.pid));
  const byStart = (a, b) => (a.startedAt - b.startedAt) || (a.pid - b.pid);
  const kids = new Map();
  const roots = [];
  for (const p of procs) {
    if (pids.has(p.ppid) && p.ppid !== p.pid) {
      if (!kids.has(p.ppid)) kids.set(p.ppid, []);
      kids.get(p.ppid).push(p);
    } else roots.push(p);
  }
  const out = [];
  const visit = (p, depth) => {
    out.push({ ...p, depth });
    for (const c of (kids.get(p.pid) || []).sort(byStart)) visit(c, depth + 1);
  };
  roots.sort(byStart).forEach((r) => visit(r, 0));
  return out;
}

/**
 * One group per leftover scope: a cloudcli-claude-* scope under cgroupRoot that is not the unit
 * of a live record, holds at least one process, and whose oldest process is at least minAgeMs old.
 * Oldest scope first.
 */
export function listLeftovers({
  cgroupRoot = defaultCgroupRoot(), recordsDir = defaultRecordsDir(), procRoot = '/proc',
  now = Date.now(), minAgeMs = 30000,
} = {}) {
  let dirs = [];
  try { dirs = fs.readdirSync(cgroupRoot, { withFileTypes: true }); } catch { return []; }
  const live = liveRecordUnits(recordsDir, procRoot);
  const boot = bootMs(procRoot);
  const groups = [];
  for (const d of dirs) {
    const m = d.name.match(UNIT_RE);
    if (!m || !d.isDirectory() || live.has(d.name)) continue;
    const procs = [];
    for (const pid of new Set(cgroupPids(path.join(cgroupRoot, d.name)))) {
      const p = readProc(pid, procRoot, boot);
      if (p) procs.push({ pid, ...p });
    }
    if (procs.length === 0) continue;
    const startedAt = Math.min(...procs.map((p) => p.startedAt));
    if (now - startedAt < minAgeMs) continue;
    groups.push({ unit: d.name, appSessionId: m[1], startedAt, processes: treeOrder(procs) });
  }
  return groups.sort((a, b) => a.startedAt - b.startedAt);
}

/** Pids of the processes below pid in the group (its descendants, by ppid). */
function descendantsIn(group, pid) {
  const out = [];
  const queue = [pid];
  while (queue.length) {
    const cur = queue.shift();
    for (const p of group.processes) if (p.ppid === cur && p.pid !== pid && !out.includes(p.pid)) { out.push(p.pid); queue.push(p.pid); }
  }
  return out;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Kills leftover processes. Body { unit, pid, procStart }: that pid and its descendants inside the
 * unit. Body { all: true }: every process of every current leftover. Each target is checked again
 * just before it is signalled (same start time, still in a leftover scope). SIGTERM first, then
 * SIGKILL for whatever still runs with the same start time after KILL_GRACE_MS.
 * Returns { status, body } for the route.
 */
export async function killLeftovers(body, deps = {}) {
  const {
    cgroupRoot, recordsDir, procRoot, minAgeMs, now = Date.now(),
    kill = (pid, sig) => process.kill(pid, sig), sleep = sleepMs, graceMs = KILL_GRACE_MS,
    avoid = [process.pid, process.ppid],
  } = deps;
  const listing = { cgroupRoot, recordsDir, procRoot, minAgeMs, now };
  const groups = listLeftovers(listing);
  let targets;
  if (body && body.all === true) {
    targets = groups.flatMap((g) => g.processes.map((p) => ({ unit: g.unit, ...p })));
  } else {
    const unit = body && body.unit;
    const pid = body && body.pid;
    if (typeof unit !== 'string' || !UNIT_RE.test(unit) || !Number.isInteger(pid) || pid <= 1) {
      return { status: 400, body: { error: 'unit and pid required (or all: true)' } };
    }
    const group = groups.find((g) => g.unit === unit);
    if (!group) return { status: 409, body: { error: 'not a leftover scope (it may have ended or belong to a live session)' } };
    const proc = group.processes.find((p) => p.pid === pid);
    if (!proc) return { status: 409, body: { error: 'pid is not in that leftover scope' } };
    if (String(body.procStart) !== proc.procStart) return { status: 409, body: { error: 'stale pid: the process has changed' } };
    const below = new Set(descendantsIn(group, pid));
    targets = group.processes.filter((p) => p.pid === pid || below.has(p.pid)).map((p) => ({ unit, ...p }));
  }
  targets = targets.filter((t) => !avoid.includes(t.pid));

  const sameProcess = (t) => {
    const cur = readProc(t.pid, procRoot);
    return !!cur && cur.procStart === t.procStart;
  };
  const term = [];
  for (const t of targets) {
    if (!sameProcess(t)) continue;
    try { kill(t.pid, 'SIGTERM'); term.push(t.pid); } catch { /* exited between check and signal */ }
  }
  if (term.length === 0) return { status: 200, body: { term: [], kill: [] } };

  await sleep(graceMs);
  const forced = [];
  for (const t of targets) {
    if (!term.includes(t.pid) || !sameProcess(t)) continue;
    try { kill(t.pid, 'SIGKILL'); forced.push(t.pid); } catch { /* exited */ }
  }
  return { status: 200, body: { term, kill: forced } };
}

/**
 * GET /leftovers body: the groups, each labelled from CloudCLI's session rows (labelFor(ids) gives a
 * Map keyed by app session id, as titlesFor in server.mjs does); the short id when there is no row.
 */
export function leftoversFor({ serverStartedAt, labelFor = () => new Map(), ...opts }) {
  const groups = listLeftovers(opts);
  const rows = labelFor(groups.map((g) => g.appSessionId));
  return {
    serverStartedAt,
    groups: groups.map((g) => {
      const row = rows.get(g.appSessionId);
      return {
        ...g,
        processes: g.processes.map((p) => ({ ...p, command: maskSecrets(p.command) })),
        title: (row && row.name && row.name.trim()) || g.appSessionId.slice(0, 8),
        project: (row && row.projectName) || null,
      };
    }),
  };
}
