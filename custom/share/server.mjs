// Public share service: GET /share/<id>/<token>/[path]. Sits behind the Cloudflare tunnel with an
// Access bypass, so it answers anyone: every refusal is the same plain 404. No dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ID_RE, isExpired, readShare, resolveInside, sharesDir } from './lib.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webm': 'video/webm', '.mp4': 'video/mp4', '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
};
// The share lives on CloudCLI's own host, whose login token sits in localStorage: the sandbox gives
// every shared page an opaque origin (scripts still run, but cannot reach that storage or cookies).
const BASE_HEADERS = {
  'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads',
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const href = (rel) => rel.split('/').map(encodeURIComponent).join('/');

const fmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Bucharest', year: 'numeric', month: 'short', day: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});

function tokenOk(given, actual) {
  const a = Buffer.from(String(given)); const b = Buffer.from(String(actual));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Files under `dir` (relative to it), skipping dotfiles and the root share.json.
function walk(dir, rel = '') {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(path.join(dir, rel)).sort(); } catch { return out; }
  for (const n of names) {
    if (n.startsWith('.') || (!rel && n === 'share.json')) continue;
    const r = rel ? `${rel}/${n}` : n;
    let st;
    try { st = fs.statSync(path.join(dir, r)); } catch { continue; }
    if (st.isDirectory()) out.push(...walk(dir, r));
    else if (st.isFile()) out.push(r);
  }
  return out;
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1f2328}
h1{font-size:1.3rem;margin:0 0 .25rem}.muted{color:#656d76;font-size:.9rem}h2{font-size:1rem;margin:1.75rem 0 .5rem}
ul{padding-left:1.1rem}li{margin:.2rem 0}a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
@media (prefers-color-scheme: dark){body{background:#0d1117;color:#e6edf3}.muted{color:#8d96a0}a{color:#4493f8}}
</style></head><body>${body}</body></html>`;
}

function shareListing(share, dir) {
  const items = [...share.items].reverse().map((i) => `<li><a href="${href(i.path) || './'}">${esc(i.title)}</a>
 <span class="muted">· ${esc(fmt.format(new Date(i.publishedAt)))}</span></li>`).join('');
  const files = walk(dir).map((f) => `<li><a href="${href(f)}">${esc(f)}</a></li>`).join('');
  return page('Shared artefacts', `<h1>Shared artefacts</h1>
<div class="muted">Link valid until ${esc(fmt.format(new Date(share.expiresAt)))}</div>
<h2>Items</h2><ul>${items || '<li class="muted">nothing yet</li>'}</ul>
<h2>All files</h2><ul>${files || '<li class="muted">no files</li>'}</ul>`);
}

function dirListing(rel, abs) {
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => { const n = e.isDirectory() ? `${e.name}/` : e.name; return `<li><a href="${href(e.name)}${e.isDirectory() ? '/' : ''}">${esc(n)}</a></li>`; })
    .join('');
  return page(rel, `<h1>${esc(rel)}</h1><div class="muted"><a href="../">..</a></div><ul>${entries}</ul>`);
}

function handle(req, res) {
  const send = (code, body, headers = {}) => {
    const buf = Buffer.from(body);
    res.writeHead(code, { ...BASE_HEADERS, 'Content-Length': buf.length, ...headers });
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
  const notFound = () => send(404, 'Not Found', { 'Content-Type': 'text/plain; charset=utf-8' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound();

  const raw = (req.url || '').split('?')[0];
  let segs;
  try { segs = raw.split('/').map(decodeURIComponent); } catch { return notFound(); }
  if (segs.some((s) => s.includes('/') || s.includes('\0') || s.includes('\\'))) return notFound();
  // ['', 'share', id, token, ...rest]
  if (segs.length < 4 || segs[0] !== '' || segs[1] !== 'share') return notFound();
  const [, , id, token, ...rest] = segs;
  if (!ID_RE.test(id) || !token) return notFound();
  const share = readShare(id);
  if (!share || !tokenOk(token, share.token) || isExpired(share)) return notFound();

  const dir = path.join(sharesDir(), id);
  const prefix = `/share/${encodeURIComponent(id)}/${encodeURIComponent(token)}/`;
  const slash = raw.endsWith('/');
  const rel = rest.filter(Boolean).join('/');

  if (!rel) {
    if (!slash || segs.length === 4) return send(301, '', { Location: prefix });
    return send(200, shareListing(share, dir), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  const abs = resolveInside(dir, rel);
  if (!abs) return notFound();
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    if (!slash) return send(301, '', { Location: `${prefix}${href(rel)}/` });
    const index = path.join(abs, 'index.html');
    if (fs.existsSync(index)) return sendFile(index);
    return send(200, dirListing(rel, abs), { 'Content-Type': 'text/html; charset=utf-8' });
  }
  if (!st.isFile() || slash) return notFound();
  return sendFile(abs);

  function sendFile(file) {
    const size = fs.statSync(file).size;
    res.writeHead(200, {
      ...BASE_HEADERS, 'Content-Length': size,
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  }
}

export function createShareServer() {
  return http.createServer((req, res) => {
    try { handle(req, res); } catch (err) {
      console.error('share-server:', err && err.stack ? err.stack : err);
      if (!res.headersSent) { res.writeHead(500, { ...BASE_HEADERS, 'Content-Type': 'text/plain' }); res.end('Internal Server Error'); }
      else res.destroy();
    }
  });
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.SHARE_PORT) || 3002;
  createShareServer().listen(port, '127.0.0.1', () => {
    console.log(`share-server: listening on 127.0.0.1:${port}, serving ${sharesDir()}`);
  });
}
