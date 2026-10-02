// claude-usage backend: wraps `claude-swap list --json`, adds Codex usage from its local session logs
// (codex.mjs), and serves GET /usage. Only whitelisted fields leave this process (no credentials are ever read).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readCodexUsage } from './codex.mjs';
import { createController } from './autoswitch.mjs';

const HOME = process.env.HOME || '';
const CANDIDATES = [path.join(HOME, '.local/bin/claude-swap'), 'claude-swap'];
const BIN = CANDIDATES.find((p) => !p.includes('/') || fs.existsSync(p));
const TTL_MS = Number(process.env.CLAUDE_USAGE_TTL_MS) || 60_000; // claude-swap hits Anthropic's usage endpoint; don't hammer it
const MIN_REFRESH_MS = process.env.CLAUDE_USAGE_TTL_MS ? 0 : 10_000; // the env override is for tests

let cache = null; // { at, body }
let inflight = null;

const pickWindow = (w) => (w && typeof w === 'object' ? {
  name: typeof w.name === 'string' ? w.name : undefined,
  pct: typeof w.pct === 'number' ? w.pct : null,
  resetsAt: w.resetsAt || null,
  countdown: w.countdown || null,
  clock: w.clock || null,
  expectedPct: typeof w.expectedPct === 'number' ? w.expectedPct : null,
  aheadOfPace: typeof w.aheadOfPace === 'boolean' ? w.aheadOfPace : null,
  willLastToReset: typeof w.willLastToReset === 'boolean' ? w.willLastToReset : null,
  projectedExhaustionAt: w.projectedExhaustionAt || null,
} : null);

function sanitize(raw) {
  const accounts = (raw.accounts || []).map((a) => ({
    number: a.number,
    email: a.email || null,
    organizationName: a.organizationName || null,
    isOrganization: !!a.isOrganization,
    active: !!a.active,
    usageStatus: a.usageStatus || null,
    usageFetchedAt: a.usageFetchedAt || null,
    fiveHour: pickWindow(a.usage && a.usage.fiveHour),
    sevenDay: pickWindow(a.usage && a.usage.sevenDay),
    scoped: Array.isArray(a.usage && a.usage.scoped) ? a.usage.scoped.map(pickWindow) : [],
  }));
  return { activeAccountNumber: raw.activeAccountNumber ?? null, accounts, fetchedAt: new Date().toISOString() };
}

function runSwap() {
  return new Promise((resolve, reject) => {
    execFile(BIN, ['list', '--json'], { timeout: 45_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        if (err && !stdout) return reject(new Error((stderr || err.message || 'claude-swap failed').trim().split('\n').pop()));
        try { resolve(sanitize(JSON.parse(stdout))); }
        catch (e) { reject(new Error(`bad JSON from claude-swap: ${e.message}`)); }
      });
  });
}

// null when Codex isn't used here; a Codex read problem never takes the Claude numbers down with it
function codexOrNull() {
  try { return readCodexUsage(); } catch (err) { console.error(`codex usage: ${err.message}`); return null; }
}

async function getUsage(force) {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && (age < (force ? MIN_REFRESH_MS : TTL_MS))) return cache.body;
  if (!inflight) {
    inflight = runSwap()
      .then((body) => ({ ...body, codex: codexOrNull() }))
      .then((body) => { cache = { at: Date.now(), body }; return body; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

// `claude-swap switch <n>`: swaps the active Claude login (Keychain / ~/.claude/.credentials.json) to a
// managed account. New Claude sessions use it; a CLAUDE_CODE_OAUTH_TOKEN pinned in the service env wins.
let switching = null;
async function switchAccount(number) {
  if (!Number.isInteger(number) || number < 1) throw Object.assign(new Error('number must be a positive integer'), { status: 400 });
  const known = await getUsage(false);
  if (!(known.accounts || []).some((a) => a.number === number)) throw Object.assign(new Error(`no account #${number}`), { status: 400 });
  if (switching) throw Object.assign(new Error('a switch is already running'), { status: 409 });
  switching = new Promise((resolve, reject) => {
    execFile(BIN, ['switch', String(number)], { timeout: 30_000, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || 'claude-swap switch failed').trim().split('\n').pop()));
      else resolve();
    });
  });
  try { await switching; } finally { switching = null; }
  cache = null;
  return getUsage(false);
}

function readJson(req, limit = 1024) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return; // keep draining so the 413 can still be sent
      raw += chunk;
      if (raw.length > limit) { tooLarge = true; raw = ''; }
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('body too large'), { status: 413 }));
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(Object.assign(new Error('bad JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const auto = createController({
  stateDir: process.env.CLAUDE_USAGE_STATE_DIR || path.join(HOME, '.claude-code-ui', 'claude-usage'),
  getUsage,
  switchTo: (n) => switchAccount(n),
  sessionsDir: process.env.CLAUDE_USAGE_SESSIONS_DIR || undefined,
});
// the payload carries the controller's view so the UI can badge the default and show the pause message
const withAuto = (body) => ({ ...body, auto: auto.status() });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/switch') {
    try {
      const body = await readJson(req);
      const usage = await switchAccount(body.number);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(withAuto(usage)));
    } catch (err) {
      res.writeHead(err.status || 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }
  if (url.pathname === '/default' && (req.method === 'PUT' || req.method === 'GET')) {
    try {
      if (req.method === 'PUT') {
        const body = await readJson(req);
        const next = {};
        if ('defaultAccount' in body) {
          if (body.defaultAccount !== null && !(Number.isInteger(body.defaultAccount) && (await getUsage(false)).accounts.some((a) => a.number === body.defaultAccount))) {
            throw Object.assign(new Error('unknown account'), { status: 400 });
          }
          next.defaultAccount = body.defaultAccount;
        }
        if ('enabled' in body) next.enabled = !!body.enabled;
        auto.setDefault(next);
        await auto.tick();
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(auto.status()));
    } catch (err) {
      res.writeHead(err.status || 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message || err) }));
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/autoswitch/log') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(auto.readLog(Math.min(1000, Number(url.searchParams.get('n')) || 200))));
    return;
  }
  if (req.method === 'GET' && (url.pathname === '/usage' || url.pathname === '/')) {
    try {
      await getUsage(url.searchParams.get('refresh') === '1');
      await auto.tick(); // a UI fetch is one of the events that triggers a check
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(withAuto(await getUsage(false)))); // re-read: the tick may have switched
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message || err), stale: cache ? cache.body : null }));
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

if (process.argv.includes('--dump')) {
  getUsage(true).then((b) => { console.log(JSON.stringify(b, null, 1)); process.exit(0); }, (e) => { console.error(e.message); process.exit(1); });
} else {
  server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, port: server.address().port })));
}
