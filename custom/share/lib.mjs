// Public artefact shares: ~/shares/<id>/{share.json, files...}. Shared by the CLI (share.mjs), the
// public server (server.mjs) and, through the CLI, the share-artefacts plugin. No dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOUR = 3600e3;
export const DEFAULT_TTL_MS = 24 * HOUR;
export const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const DEFAULT_BASE_URL = 'https://cloudcli.example.com';
const REPO_ENV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');

export function sharesDir() {
  return process.env.SHARES_DIR || path.join(process.env.HOME || os.homedir(), 'shares');
}

export function baseUrl() {
  let url = process.env.SHARE_BASE_URL;
  if (!url) {
    try {
      const m = fs.readFileSync(REPO_ENV, 'utf8').match(/^SHARE_BASE_URL=(.*)$/m);
      if (m) url = m[1].trim().replace(/^["']|["']$/g, '');
    } catch { /* no .env */ }
  }
  return (url || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function parseDuration(s) {
  const m = /^(\d+)([mhd])$/.exec(String(s || ''));
  if (!m || Number(m[1]) <= 0) throw new Error(`bad duration "${s}" (use e.g. 90m, 24h, 3d)`);
  return Number(m[1]) * { m: 60e3, h: HOUR, d: 24 * HOUR }[m[2]];
}

export function newToken() { return crypto.randomBytes(24).toString('base64url'); }

export function newSeparateId() {
  const abc = 'abcdefghijklmnopqrstuvwxyz234567';
  return `x-${[...crypto.randomBytes(8)].map((b) => abc[b & 31]).join('')}`;
}

const shareDir = (id) => path.join(sharesDir(), id);

export function readShare(id) {
  if (!ID_RE.test(String(id))) return null;
  try {
    const s = JSON.parse(fs.readFileSync(path.join(shareDir(id), 'share.json'), 'utf8'));
    if (!s || s.id !== id || typeof s.token !== 'string' || !s.token || !Array.isArray(s.items)
      || Number.isNaN(Date.parse(s.expiresAt))) return null;
    return s;
  } catch { return null; }
}

export function writeShare(share) {
  const dir = shareDir(share.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.share.json.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, `${JSON.stringify(share, null, 2)}\n`);
  fs.renameSync(tmp, path.join(dir, 'share.json'));
  return share;
}

const lastPublish = (s) => Math.max(Date.parse(s.createdAt) || 0, ...s.items.map((i) => Date.parse(i.publishedAt) || 0));

export function listShares() {
  let ids = [];
  try { ids = fs.readdirSync(sharesDir()); } catch { return []; }
  return ids.map(readShare).filter(Boolean).sort((a, b) => lastPublish(b) - lastPublish(a));
}

const LOCAL = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Bucharest', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});
/** "2026-10-03 14:27 EEST": the user reads every time in Bucharest local time. */
export function formatLocal(iso) {
  const p = Object.fromEntries(LOCAL.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
}
export function formatLeft(ms) {
  if (ms <= 0) return 'expired';
  const mins = Math.round(ms / 60e3);
  const h = Math.floor(mins / 60);
  return `in ${h ? `${h}h ` : ''}${mins % 60}m`;
}

export function isExpired(share, now = Date.now()) { return now >= Date.parse(share.expiresAt); }

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
export function shareUrl(share) { return `${baseUrl()}/share/${share.id}/${share.token}/`; }
export function itemUrl(share, item) { return shareUrl(share) + encodePath(item.path); }

function mustRead(id) {
  const s = readShare(id);
  if (!s) throw new Error(`no such share: ${id}`);
  return s;
}

export function extendShare(id, ms, now = Date.now()) {
  const s = mustRead(id);
  s.expiresAt = new Date(Math.max(now, Date.parse(s.expiresAt)) + ms).toISOString();
  return writeShare(s);
}

export function expireShare(id, now = Date.now()) {
  const s = mustRead(id);
  s.expiresAt = new Date(now).toISOString();
  return writeShare(s);
}

const KINDS = {
  '.html': 'html', '.htm': 'html', '.md': 'markdown', '.markdown': 'markdown',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image',
};
const kindOf = (p) => (p.endsWith('/') ? 'dir' : KINDS[path.extname(p).toLowerCase()] || 'file');

const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

function freeName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const e = ext && ext !== name ? ext : '';
  for (let n = 2; ; n += 1) if (!fs.existsSync(path.join(dir, `${stem}-${n}${e}`))) return `${stem}-${n}${e}`;
}

// Copy a file or a directory tree. Symlinks are followed only when they stay inside `rootReal`.
function copyTree(from, to, rootReal, warnings) {
  const st = fs.lstatSync(from);
  let real = from;
  if (st.isSymbolicLink()) {
    try { real = fs.realpathSync(from); } catch { warnings.push(`skipped broken symlink ${from}`); return; }
    if (!isInside(real, rootReal)) { warnings.push(`skipped symlink leaving the source: ${from}`); return; }
  }
  const rst = fs.statSync(real);
  if (rst.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(real)) copyTree(path.join(real, name), path.join(to, name), rootReal, warnings);
  } else if (rst.isFile()) {
    fs.copyFileSync(real, to);
  }
}

function cleanDest(dest) {
  const d = String(dest || '').replace(/^\/+|\/+$/g, '');
  if (!d) return '';
  if (path.isAbsolute(d) || d.split('/').some((seg) => !seg || seg === '.' || seg === '..')) {
    throw new Error(`bad --dest "${dest}"`);
  }
  return d;
}

/**
 * Copy `srcs` into a share as one item. Without `separate`, the share is the session's own
 * (id = sessionId); with it, a new share with its own id and ttl. Returns { share, item, warnings }.
 */
export function publish({ srcs, title, dest, separate = false, ttlMs = DEFAULT_TTL_MS, sessionId, projectPath = null, now = Date.now() }) {
  if (!Array.isArray(srcs) || srcs.length === 0) throw new Error('nothing to publish');
  if (!sessionId) throw new Error('no session id');
  const root = sharesDir();
  fs.mkdirSync(root, { recursive: true });
  const rootReal = fs.realpathSync(root);
  const sources = srcs.map((s) => {
    const abs = path.resolve(s);
    let real;
    try { real = fs.realpathSync(abs); } catch { throw new Error(`not found: ${s}`); }
    if (isInside(real, rootReal)) throw new Error(`refusing to publish a path inside the shares folder: ${s}`);
    return { abs, real };
  });
  const sub = cleanDest(dest);

  const id = separate ? newSeparateId() : sessionId;
  if (!ID_RE.test(id)) throw new Error(`bad share id: ${id}`);
  let share = separate ? null : readShare(id);
  if (!share) {
    share = {
      version: 1, id, token: newToken(), sessionId, projectPath, separate: Boolean(separate),
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(), items: [],
    };
  } else if (isExpired(share, now)) {
    share.expiresAt = new Date(now + DEFAULT_TTL_MS).toISOString();
  }
  const dir = shareDir(id);
  const itemTitle = String(title || path.basename(sources[0].abs)).trim();

  // Same title again: the new copy replaces the old one.
  const old = share.items.find((i) => i.title === itemTitle);
  if (old) {
    for (const f of old.files || []) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    share.items = share.items.filter((i) => i !== old);
  }

  const targetDir = path.join(dir, sub);
  fs.mkdirSync(targetDir, { recursive: true });
  const warnings = [];
  const files = [];
  for (const { abs, real } of sources) {
    const name = freeName(targetDir, path.basename(abs));
    copyTree(abs, path.join(targetDir, name), fs.statSync(real).isDirectory() ? real : path.dirname(real), warnings);
    files.push(sub ? `${sub}/${name}` : name);
  }

  let itemPath;
  if (files.length === 1) {
    const only = files[0];
    if (fs.statSync(path.join(dir, only)).isDirectory()) {
      itemPath = fs.existsSync(path.join(dir, only, 'index.html')) ? `${only}/index.html` : `${only}/`;
    } else itemPath = only;
  } else itemPath = sub ? `${sub}/` : '';
  const item = { title: itemTitle, path: itemPath, kind: itemPath === '' ? 'dir' : kindOf(itemPath), files, publishedAt: new Date(now).toISOString() };
  share.items.push(item);
  writeShare(share);
  return { share, item, warnings };
}

export function purge({ id, expired = false, now = Date.now() } = {}) {
  const victims = id ? [mustRead(id)] : expired ? listShares().filter((s) => isExpired(s, now)) : [];
  for (const s of victims) fs.rmSync(shareDir(s.id), { recursive: true, force: true });
  return victims.map((s) => s.id);
}

/** Real path of `rel` inside `root`, or null for anything outside, private or missing. */
export function resolveInside(root, rel) {
  const r = String(rel || '');
  if (r.startsWith('/') || r.includes('\0')) return null;
  const segs = r.split('/').filter(Boolean);
  if (segs.some((s) => s.startsWith('.'))) return null;
  if (segs.length === 1 && segs[0] === 'share.json') return null;
  try {
    const rootReal = fs.realpathSync(root);
    const real = fs.realpathSync(path.join(rootReal, ...segs));
    if (!isInside(real, rootReal)) return null;
    if (real === path.join(rootReal, 'share.json')) return null;
    return real;
  } catch { return null; }
}

/** The Claude session this process runs under: walk up the parents to one with a status file. */
export function findSession(startPid = process.pid) {
  const dir = path.join(process.env.HOME || os.homedir(), '.claude', 'sessions');
  let pid = startPid;
  for (let i = 0; i < 64 && pid > 1; i += 1) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8'));
      if (d && d.sessionId) return { sessionId: d.sessionId, cwd: d.cwd || null };
    } catch { /* not a claude process */ }
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { return null; }
  }
  return null;
}
