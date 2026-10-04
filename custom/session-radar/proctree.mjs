// Process tree of a session: the live /proc subtree merged with the exec tracer's
// log (custom/exec-tracer), so commands that already finished still show, with
// exit code and duration. Read-only; everything degrades to an empty tree.
import fs from 'node:fs';
import path from 'node:path';
import { processTree, rssKb, shellCommand } from './detail.mjs';

export const LOG_DIR = '/var/log/agent-exec';
const CLK_TCK = 100;
const KEEP_MS = 24 * 60 * 60 * 1000;
const AGENT_COMMS = new Set(['claude', 'claude-swap']);

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

let bootMs = null;
function bootTimeMs() {
  if (bootMs == null) {
    const m = (readText('/proc/stat') || '').match(/^btime (\d+)/m);
    bootMs = m ? Number(m[1]) * 1000 : 0;
  }
  return bootMs;
}

/** ppid, comm, start time and argv of a live pid, or null when it is gone. */
export function procInfo(pid) {
  const stat = readText(`/proc/${pid}/stat`);
  if (!stat) return null;
  const close = stat.lastIndexOf(')');
  const comm = stat.slice(stat.indexOf('(') + 1, close);
  const f = stat.slice(close + 2).split(' '); // f[0] = state (field 3)
  const cmdline = readText(`/proc/${pid}/cmdline`) || '';
  const argv = cmdline.split('\0').filter(Boolean).join(' ') || comm;
  return { pid, ppid: Number(f[1]), comm, startMs: bootTimeMs() + Math.round((Number(f[19]) / CLK_TCK) * 1000), argv, cmdline };
}

/**
 * What to show for a process: a Claude shell wrapper shows the command it runs. A wrapper whose
 * record was cut before the `eval` (the tracer's per-argument limit) says so instead of showing
 * the wrapper's preamble.
 */
export function commandLabel(argv, cmdline) {
  const text = cmdline || argv;
  // The Bash tool's wrapper is `<shell> -c source …/.claude/shell-snapshots/… && … eval '<cmd>'`;
  // other shells mentioning shell-snapshots (the snapshot builder) are shown as they are.
  if (!/-c source \S*\.claude\/shell-snapshots\//.test(text.replace(/\0/g, ' '))) return argv;
  if (!/eval ['"]/.test(text)) return `${path.basename(argv.split(' ')[0])} (Bash tool, command cut)`;
  return shellCommand(text) || argv;
}

/** The live subtree of rootPid as Node objects (parent = ppid, root = rootPid). */
export function liveTree(rootPid) {
  const nodes = [];
  for (const pid of processTree(rootPid)) {
    const info = procInfo(pid);
    if (!info) continue;
    nodes.push({
      pid, parent: pid === rootPid ? null : info.ppid, root: rootPid, argv: info.argv,
      cmd: commandLabel(info.argv, info.cmdline), live: true, rssKb: rssKb(pid),
      startMs: info.startMs, endMs: null, code: null, sig: null,
    });
  }
  return nodes;
}

/** The topmost claude / claude-swap ancestor of pid (claude run through claude-swap), else pid. */
export function topAgentAncestor(pid) {
  let top = pid;
  let cur = procInfo(pid);
  for (let i = 0; cur && i < 20; i++) {
    const parent = procInfo(cur.ppid);
    if (!parent || parent.pid <= 1 || !AGENT_COMMS.has(parent.comm)) break;
    top = parent.pid;
    cur = parent;
  }
  return top;
}

/** claude / claude-swap processes of uid that are not inside any excluded pid's tree. */
export function otherAgentPids(uid, exclude) {
  const inside = new Set();
  for (const p of exclude) for (const q of processTree(p)) inside.add(q);
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync('/proc'); } catch { return out; }
  for (const d of dirs) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    if (inside.has(pid)) continue;
    let st;
    try { st = fs.statSync(`/proc/${pid}`); } catch { continue; }
    if (st.uid !== uid) continue;
    const info = procInfo(pid);
    if (!info || !AGENT_COMMS.has(info.comm)) continue;
    // Only the top of a claude-swap -> claude chain; the rest is its tree.
    if (topAgentAncestor(pid) !== pid) continue;
    out.push(pid);
  }
  return out;
}

export function parseLogLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* cut line (rotation, write in progress) */ }
  }
  return out;
}

/** The current user's exec log, read incrementally; records() is null when the tracer is not installed. */
export class ExecLog {
  constructor(dir = LOG_DIR, uid = process.getuid()) {
    this.file = path.join(dir, `${uid}.jsonl`);
    this.offset = 0; this.ino = null; this.recs = null;
  }

  records() {
    let st;
    try { st = fs.statSync(this.file); } catch { return this.recs; } // missing now: keep what we had (null if never)
    if (this.recs === null) {
      this.recs = parseLogLines(readText(`${this.file}.1`) || '');
    }
    if (this.ino !== st.ino || st.size < this.offset) {
      // Rotated since the last read: the old file is now `.1`; take what it got after our offset,
      // then start the new file from 0.
      if (this.ino !== null) this.offset += this.readFrom(`${this.file}.1`, this.offset);
      this.offset = 0; this.ino = st.ino;
    }
    if (st.size > this.offset) this.offset += this.readFrom(this.file, this.offset);
    const minTs = Date.now() - KEEP_MS;
    if (this.recs.length && this.recs[0].ts < minTs) this.recs = this.recs.filter((r) => r.ts >= minTs);
    return this.recs;
  }

  /** Parses the whole lines of `file` from `offset` into recs; returns the bytes consumed. */
  readFrom(file, offset) {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return 0; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return 0;
      const buf = Buffer.alloc(size - offset);
      const n = fs.readSync(fd, buf, 0, buf.length, offset);
      const text = buf.toString('utf8', 0, n);
      const cut = text.lastIndexOf('\n');
      if (cut < 0) return 0;
      const whole = text.slice(0, cut + 1);
      this.recs.push(...parseLogLines(whole));
      return Buffer.byteLength(whole);
    } finally { fs.closeSync(fd); }
  }
}

/**
 * One flat node list for rootPids: live nodes, plus log records whose root is a
 * pid already in the tree (so nested claude runs are followed) and newer than the
 * root process. A record for a pid still live only confirms it; a second exec of
 * the same pid before its exit (sh -c that execs its command) updates the argv.
 */
export function buildTree({ rootPids, live, records, cap = 500 }) {
  const nodes = new Map(live.map((n) => [n.pid, n]));
  const rootStart = Math.min(...rootPids.map((p) => (nodes.get(p) || {}).startMs || Infinity), Infinity);
  const minTs = rootStart === Infinity ? 0 : rootStart - 1000;
  const sorted = [...(records || [])].sort((a, b) => a.ts - b.ts);
  for (const r of sorted) {
    if (r.ts < minTs) continue;
    if (r.ev === 'exec') {
      if (!nodes.has(r.root)) continue;
      const cur = nodes.get(r.pid);
      if (cur && cur.live) continue;
      if (cur && cur.endMs == null) { cur.argv = r.argv; cur.cmd = commandLabel(r.argv); continue; } // same pid re-exec
      // The real parent when it is in the tree; else the nearest logged ancestor (a subshell that
      // forked without exec is never logged), else the claude root.
      const parent = [r.ppid, r.lparent, r.root].find((p) => p !== r.pid && nodes.has(p)) ?? null;
      nodes.set(r.pid, {
        pid: r.pid, parent, root: r.root, argv: r.argv, cmd: commandLabel(r.argv), live: false,
        rssKb: 0, startMs: r.ts, endMs: null, code: null, sig: null,
      });
    } else if (r.ev === 'exit') {
      const cur = nodes.get(r.pid);
      if (cur && !cur.live) { cur.endMs = r.ts; cur.code = r.code; cur.sig = r.sig ?? 0; }
    }
  }
  let truncated = 0;
  if (nodes.size > cap) {
    const dead = [...nodes.values()].filter((n) => !n.live).sort((a, b) => b.startMs - a.startMs);
    const keep = Math.max(0, cap - (nodes.size - dead.length));
    for (const n of dead.slice(keep)) { nodes.delete(n.pid); truncated += 1; }
  }
  // A parent that is gone (never logged, or dropped by the cap): hang the node on its root.
  const roots = new Set(rootPids);
  for (const n of nodes.values()) {
    if (n.parent != null && !nodes.has(n.parent)) {
      n.parent = nodes.has(n.root) && n.root !== n.pid ? n.root : (roots.has(n.pid) ? null : rootPids[0]);
    }
  }
  return { roots: rootPids, nodes: [...nodes.values()].sort((a, b) => a.startMs - b.startMs), truncated };
}
