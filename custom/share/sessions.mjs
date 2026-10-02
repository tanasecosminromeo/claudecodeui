// Session facts for the Artefacts list: name, project, status (waiting / busy / idle while a
// process runs, else archived / ended) and the last message. Read-only; every source is optional.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { procStartOf } from '../session-radar/detail.mjs';

const TAIL_BYTES = 256 * 1024;
const MAX_LEN = 140;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join(' ');
}

/** Last user/assistant text in transcript JSONL, whitespace-collapsed and cut to 140 chars. */
export function lastMessageOf(text) {
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i]) continue;
    let j;
    try { j = JSON.parse(lines[i]); } catch { continue; }
    if ((j.type !== 'user' && j.type !== 'assistant') || !j.message || j.isMeta) continue;
    const t = textOf(j.message.content).replace(/\s+/g, ' ').trim();
    if (!t || t.startsWith('<')) continue; // tool results, notifications, command wrappers
    return t.length > MAX_LEN ? `${t.slice(0, MAX_LEN - 1)}…` : t;
  }
  return null;
}

function tail(file) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const s = buf.toString('utf8');
    return st.size > len ? s.slice(s.indexOf('\n') + 1) : s;
  } catch { return ''; }
}

function transcriptFiles(home, ids) {
  const out = new Map();
  const root = path.join(home, '.claude', 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    for (const id of ids) {
      const f = path.join(root, d, `${id}.jsonl`);
      if (!out.has(id) && fs.existsSync(f)) out.set(id, f);
    }
  }
  return out;
}

function liveStates(home) {
  const out = new Map(); // sessionId -> { status, name, cwd }
  const dir = path.join(home, '.claude', 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return out; }
  const rank = { waiting: 0, busy: 1, idle: 2 };
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!d || !d.sessionId || !d.pid) continue;
    const start = procStartOf(d.pid);
    if (!start || (d.procStart && String(d.procStart) !== start)) continue; // dead or pid reused
    const status = d.status === 'waiting' || d.status === 'busy' ? d.status : 'idle';
    const prev = out.get(d.sessionId);
    if (!prev || rank[status] < rank[prev.status]) out.set(d.sessionId, { status, name: d.name || null, cwd: d.cwd || null });
  }
  return out;
}

// node:sqlite loads synchronously once imported; keep the API sync by importing up front.
const sqlite = await (async () => { try { process.removeAllListeners('warning'); return await import('node:sqlite'); } catch { return null; } })();

function dbRows(home, ids) {
  const out = new Map();
  const file = path.join(home, '.cloudcli', 'auth.db');
  if (!sqlite || ids.length === 0 || !fs.existsSync(file)) return out;
  let db;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const q = ids.map(() => '?').join(',');
    const rows = db.prepare(
      'SELECT s.session_id AS id, s.provider_session_id AS providerId, s.custom_name AS name, s.isArchived AS archived, '
      + 's.project_path AS projectPath, p.custom_project_name AS projectName '
      + 'FROM sessions s LEFT JOIN projects p ON p.project_path = s.project_path '
      + `WHERE s.session_id IN (${q}) OR s.provider_session_id IN (${q})`,
    ).all(...ids, ...ids);
    for (const r of rows) { out.set(r.id, r); if (r.providerId) out.set(r.providerId, r); }
  } catch { /* schema changed upstream: names fall back */ }
  finally { try { db && db.close(); } catch { /* ignore */ } }
  return out;
}

/** Map of Claude session id -> { title, project, status, archived, lastMessage, appSessionId }. */
export function sessionInfo(ids, { home = process.env.HOME || os.homedir() } = {}) {
  const uniq = [...new Set(ids.filter(Boolean))];
  const live = liveStates(home);
  const rows = dbRows(home, uniq);
  const files = transcriptFiles(home, uniq);
  const out = new Map();
  for (const id of uniq) {
    const l = live.get(id);
    const r = rows.get(id);
    const archived = Boolean(r && r.archived);
    const cwd = (l && l.cwd) || (r && r.projectPath) || null;
    out.set(id, {
      title: (r && r.name && r.name.trim()) || (l && l.name) || id.slice(0, 8),
      project: (r && r.projectName) || (cwd ? path.basename(cwd) : null),
      status: l ? l.status : archived ? 'archived' : 'ended',
      archived,
      lastMessage: files.has(id) ? lastMessageOf(tail(files.get(id))) : null,
      appSessionId: (r && r.id) || id,
    });
  }
  return out;
}

