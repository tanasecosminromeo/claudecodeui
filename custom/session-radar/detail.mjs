// Per-session facts for the Running view: memory and children of the live
// process tree (/proc), plus model, branch, context size and running agents
// from the tail of the transcript. Read-only; everything degrades to null.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TAIL_BYTES = 256 * 1024;
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const tailCache = new Map(); // file -> { key, value }

function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

export function rssKb(pid) {
  const m = (readText(`/proc/${pid}/status`) || '').match(/^VmRSS:\s+(\d+)\s+kB/m);
  return m ? Number(m[1]) : 0;
}

function childPids(pid) {
  let tasks = [];
  try { tasks = fs.readdirSync(`/proc/${pid}/task`); } catch { return []; }
  return tasks.flatMap((t) => (readText(`/proc/${pid}/task/${t}/children`) || '').trim().split(/\s+/).filter(Boolean).map(Number));
}

/** The pid plus all its descendants (bounded, in case of a runaway tree). */
export function processTree(pid, limit = 200) {
  const out = [];
  const queue = [pid];
  while (queue.length && out.length < limit) {
    const p = queue.shift();
    out.push(p);
    queue.push(...childPids(p));
  }
  return out;
}

// A Bash-tool command (foreground, background task or Monitor) is a shell that
// sources a ~/.claude/shell-snapshots file; show what it is running.
export function shellCommand(cmdline) {
  if (!cmdline.includes('.claude/shell-snapshots/')) return null;
  const args = cmdline.split('\0');
  const i = args.indexOf('-c');
  const script = (i >= 0 ? args[i + 1] : args.join(' ')) || '';
  const eva = script.match(/eval '?"?(.*)$/s);
  // The wrapper quotes the command (eval '...'); drop the closing quote that is left after the cut.
  const cmd = (eva ? eva[1] : script).split('\n')[0].replace(/\s+/g, ' ').replace(/< \/dev\/null.*$/, '').trim().replace(/['"]$/, '');
  return cmd.slice(0, 80);
}

export function processDetail(pid) {
  const tree = processTree(pid);
  let kb = 0;
  const commands = [];
  for (const p of tree) {
    kb += rssKb(p);
    if (p === pid) continue;
    const cmd = readText(`/proc/${p}/cmdline`);
    const sh = cmd && shellCommand(cmd);
    if (sh) commands.push(sh);
  }
  return { rssKb: kb, procs: tree.length, commands };
}

/** Parse transcript JSONL lines (the tail of a file) into session facts. */
export function parseTranscriptTail(text) {
  const lines = text.split('\n');
  const toolUses = new Map(); // id -> { name, background }
  const done = new Set();
  let model = null; let usage = null; let branch = null; let mode = null;
  for (const line of lines) {
    if (!line) continue;
    if (line.includes('<task-notification>')) {
      for (const m of line.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) done.add(m[1]);
    }
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.gitBranch) branch = j.gitBranch;
    if (j.type === 'mode' && j.mode) mode = j.mode;
    if (j.permissionMode) mode = j.permissionMode;
    const content = j.message && Array.isArray(j.message.content) ? j.message.content : [];
    if (j.type === 'assistant' && j.message) {
      if (j.message.model && j.message.model !== '<synthetic>') model = j.message.model;
      if (j.message.usage) usage = j.message.usage;
      for (const c of content) {
        if (c.type === 'tool_use' && AGENT_TOOLS.has(c.name)) {
          toolUses.set(c.id, { background: Boolean(c.input && c.input.run_in_background) });
        }
      }
    } else if (j.type === 'user') {
      for (const c of content) {
        if (c.type !== 'tool_result' || !toolUses.has(c.tool_use_id)) continue;
        // A background agent answers at once ("launched"); it only ends with its notification.
        if (!toolUses.get(c.tool_use_id).background) done.add(c.tool_use_id);
      }
    }
  }
  let agents = 0;
  for (const id of toolUses.keys()) if (!done.has(id)) agents += 1;
  const context = usage
    ? (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
    : null;
  return { model, branch, mode, contextTokens: context, agents };
}

export function transcriptDetail(file) {
  if (!file) return null;
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = tailCache.get(file);
  if (hit && hit.key === key) return hit.value;
  let value = null;
  try {
    const fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    let text = buf.toString('utf8');
    if (st.size > len) text = text.slice(text.indexOf('\n') + 1); // first line is cut
    value = parseTranscriptTail(text);
  } catch { value = null; }
  tailCache.set(file, { key, value });
  if (tailCache.size > 200) tailCache.delete(tailCache.keys().next().value);
  return value;
}

/** Start time (/proc stat field 22) of a pid, or null when it is gone. */
export function procStartOf(pid) {
  const stat = readText(`/proc/${pid}/stat`);
  // comm (field 2) may contain spaces, so split after the closing ')'
  return stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] : null;
}

/**
 * The live pids Claude Code registered for a session in `sessionsDir`
 * (<pid>.json status files). A pid counts only while the process still has the
 * recorded start time (so a reused pid is never returned) and belongs to us.
 */
export function livePidsOf(sessionId, sessionsDir) {
  let files = [];
  try { files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const pids = [];
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
    if (!d || d.sessionId !== sessionId || !d.pid) continue;
    const start = procStartOf(d.pid);
    if (!start || (d.procStart && String(d.procStart) !== start)) continue;
    try { if (fs.statSync(`/proc/${d.pid}`).uid !== process.getuid()) continue; } catch { continue; }
    pids.push(d.pid);
  }
  return pids;
}

/** SIGTERM the session's Claude process(es); returns the pids signalled. */
export function stopSession(sessionId, sessionsDir, kill = process.kill) {
  const pids = livePidsOf(sessionId, sessionsDir);
  for (const pid of pids) kill(pid, 'SIGTERM');
  return pids;
}

/** Whole-machine figures to put the sessions' memory in context. */
export function machineStats() {
  const mem = readText('/proc/meminfo') || '';
  const kb = (key) => Number((mem.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm')) || [])[1] || 0);
  return {
    cpus: os.cpus().length,
    load: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memTotalMb: Math.round(kb('MemTotal') / 1024),
    memAvailMb: Math.round(kb('MemAvailable') / 1024),
  };
}
