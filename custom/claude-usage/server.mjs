// claude-usage backend: wraps `claude-swap list --json` and serves GET /usage.
// Only whitelisted fields leave this process (no credentials are ever read).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HOME = process.env.HOME || '';
const CANDIDATES = [path.join(HOME, '.local/bin/claude-swap'), 'claude-swap'];
const BIN = CANDIDATES.find((p) => !p.includes('/') || fs.existsSync(p));
const TTL_MS = 60_000; // claude-swap hits Anthropic's usage endpoint; don't hammer it
const MIN_REFRESH_MS = 10_000;

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

async function getUsage(force) {
  const age = cache ? Date.now() - cache.at : Infinity;
  if (cache && (age < (force ? MIN_REFRESH_MS : TTL_MS))) return cache.body;
  if (!inflight) {
    inflight = runSwap()
      .then((body) => { cache = { at: Date.now(), body }; return body; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && (url.pathname === '/usage' || url.pathname === '/')) {
    try {
      const body = await getUsage(url.searchParams.get('refresh') === '1');
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
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
