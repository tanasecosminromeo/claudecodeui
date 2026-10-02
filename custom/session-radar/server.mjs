// session-radar backend: reads Claude Code's own per-process status files
// (~/.claude/sessions/<pid>.json), transcript mtimes and CloudCLI's session
// titles, and serves GET /sessions to the CloudCLI plugin RPC proxy.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { machineStats, processDetail, procStartOf, stopSession, transcriptDetail } from './detail.mjs';

const HOME = process.env.HOME || os.homedir();
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const DB_PATH = path.join(HOME, '.cloudcli', 'auth.db');
const RECENT_MS = 24 * 60 * 60 * 1000;
const STATE_RANK = { waiting: 0, busy: 1, idle: 2, ended: 3 };

// ---- CloudCLI titles (optional; node:sqlite is built into Node >= 22.5) ----
let db = null;
try {
  process.removeAllListeners('warning'); // silence the "SQLite is experimental" warning
  const { DatabaseSync } = await import('node:sqlite');
  if (fs.existsSync(DB_PATH)) db = new DatabaseSync(DB_PATH, { readOnly: true });
} catch { db = null; }

function titlesFor(ids) {
  const out = new Map();
  if (!db || ids.length === 0) return out;
  try {
    const stmt = db.prepare(
      'SELECT s.session_id AS id, s.provider_session_id AS providerId, s.custom_name AS name, s.isArchived AS archived, p.custom_project_name AS projectName ' +
      'FROM sessions s LEFT JOIN projects p ON p.project_path = s.project_path ' +
      `WHERE s.session_id IN (${ids.map(() => '?').join(',')}) OR s.provider_session_id IN (${ids.map(() => '?').join(',')})`,
    );
    // Chats started from the CloudCLI UI get an app id (session_id) that differs
    // from Claude's own id (provider_session_id, used in ~/.claude): key by both.
    for (const row of stmt.all(...ids, ...ids)) {
      out.set(row.id, row);
      if (row.providerId) out.set(row.providerId, row);
    }
  } catch { /* schema changed upstream: fall back to derived names */ }
  return out;
}

// ---- process liveness ----
function childrenOf(pid) {
  try {
    const tasks = fs.readdirSync(`/proc/${pid}/task`);
    return tasks.flatMap((t) => {
      try { return fs.readFileSync(`/proc/${pid}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); }
      catch { return []; }
    });
  } catch { return []; }
}

// Live Bash-tool work (foreground command, background task, Monitor) runs as a
// shell child that sources a ~/.claude/shell-snapshots file.
function shellTasksOf(pid) {
  let n = 0;
  for (const c of childrenOf(pid)) {
    try {
      const cmd = fs.readFileSync(`/proc/${c}/cmdline`, 'utf8');
      if (cmd.includes('.claude/shell-snapshots/')) n += 1;
    } catch { /* exited */ }
  }
  return n;
}

// ---- transcripts ----
function transcriptIndex() {
  const idx = new Map(); // sessionId -> { mtime, cwdDir }
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return idx; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(PROJECTS_DIR, d.name)); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      try {
        const st = fs.statSync(path.join(PROJECTS_DIR, d.name, f));
        const id = f.slice(0, -6);
        const prev = idx.get(id);
        if (!prev || st.mtimeMs > prev.mtime) idx.set(id, { mtime: st.mtimeMs, file: path.join(PROJECTS_DIR, d.name, f) });
      } catch { /* raced a delete */ }
    }
  }
  return idx;
}

// cwd of a session that is no longer live: read the first line carrying "cwd"
function cwdFromTranscript(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; }
}

// ---- live-process detail ----
function liveDetail(s, transcript) {
  let rssKb = 0; let procs = 0; const commands = [];
  for (const pid of s.pids) {
    const d = processDetail(pid);
    rssKb += d.rssKb; procs += d.procs; commands.push(...d.commands);
  }
  const t = transcriptDetail(transcript && transcript.file) || {};
  return {
    rssMb: Math.round(rssKb / 1024), procs, commands: commands.slice(0, 5),
    agents: t.agents || 0, model: t.model || null, branch: t.branch || null,
    mode: t.mode || null, contextTokens: t.contextTokens || null,
  };
}

// ---- main query ----
function listSessions() {
  const now = Date.now();
  const bySession = new Map();

  let files = [];
  try { files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')); } catch { /* none */ }
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); } catch { continue; }
    if (!d || !d.sessionId || !d.pid) continue;
    const start = procStartOf(d.pid);
    if (!start || (d.procStart && String(d.procStart) !== start)) continue; // dead or pid reused
    const state = d.status === 'waiting' ? 'waiting' : d.status === 'busy' ? 'busy' : 'idle';
    const s = bySession.get(d.sessionId) || {
      sessionId: d.sessionId, cwd: d.cwd, name: d.name || null, entrypoint: d.entrypoint || null,
      state: 'ended', waitingFor: null, pids: [], tasks: 0, statusAt: 0, live: true,
      startedAt: d.startedAt || null, version: d.version || null,
    };
    s.pids.push(d.pid);
    s.tasks += shellTasksOf(d.pid);
    if (STATE_RANK[state] < STATE_RANK[s.state]) { s.state = state; s.waitingFor = d.waitingFor || null; }
    s.statusAt = Math.max(s.statusAt, d.statusUpdatedAt || d.updatedAt || 0);
    bySession.set(d.sessionId, s);
  }

  const transcripts = transcriptIndex();
  for (const [id, t] of transcripts) {
    const s = bySession.get(id);
    if (s) { s.transcriptAt = t.mtime; continue; }
    if (now - t.mtime > RECENT_MS) continue;
    bySession.set(id, {
      sessionId: id, cwd: cwdFromTranscript(t.file), name: null, entrypoint: null, state: 'ended',
      waitingFor: null, pids: [], tasks: 0, statusAt: 0, transcriptAt: t.mtime, live: false,
    });
  }

  const titles = titlesFor([...bySession.keys()]);
  const out = [];
  for (const s of bySession.values()) {
    const row = titles.get(s.sessionId);
    if (row && row.archived && !s.live) continue; // a running process is never hidden
    // "last message" = last transcript write; fall back to the status timestamp
    s.lastMessage = s.transcriptAt || s.statusAt || null;
    s.lastActivity = Math.max(s.statusAt || 0, s.transcriptAt || 0) || null;
    const recent = s.lastActivity && now - s.lastActivity <= RECENT_MS;
    s.active = s.live || s.state === 'waiting' || s.state === 'busy' || s.tasks > 0 || !!recent;
    if (!s.active) continue;
    s.title = (row && row.name && row.name.trim()) || s.name || s.sessionId.slice(0, 8);
    s.appSessionId = (row && row.id) || s.sessionId; // what CloudCLI routes on (/session/<id>)
    s.project = (row && row.projectName) || (s.cwd ? path.basename(s.cwd) : null);
    s.archived = Boolean(row && row.archived);
    if (s.live) Object.assign(s, liveDetail(s, transcripts.get(s.sessionId)));
    delete s.statusAt; delete s.transcriptAt;
    out.push(s);
  }

  // Needs you > running > idle > ended; within a group, most recent message first.
  out.sort((a, b) => (STATE_RANK[a.state] - STATE_RANK[b.state]) || ((b.lastMessage || 0) - (a.lastMessage || 0)));
  return { now, machine: machineStats(), sessions: out };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/sessions' || url.pathname === '/')) {
    let body;
    try { body = JSON.stringify(listSessions()); }
    catch (err) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(err) })); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/stop') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 4096) req.destroy(); });
    req.on('end', () => {
      let sessionId = null;
      try { sessionId = JSON.parse(raw).sessionId; } catch { /* bad body */ }
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (typeof sessionId !== 'string' || !sessionId) return send(400, { error: 'sessionId required' });
      try {
        const pids = stopSession(sessionId, SESSIONS_DIR);
        if (pids.length === 0) return send(404, { error: 'no live process for that session' });
        send(200, { stopped: pids });
      } catch (err) { send(500, { error: String(err) }); }
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ ready: true, port: server.address().port }));
});

if (process.argv.includes('--dump')) { console.log(JSON.stringify(listSessions(), null, 1)); process.exit(0); }
