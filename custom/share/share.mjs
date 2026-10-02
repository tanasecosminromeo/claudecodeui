#!/usr/bin/env node
// share: publish files from a Claude session to a public, expiring link. See README.md.
import {
  DEFAULT_TTL_MS, expireShare, extendShare, findSession, formatLeft, formatLocal, isExpired, itemUrl, listShares,
  parseDuration, publish, purge, readShare, shareUrl,
} from './lib.mjs';

const USAGE = `usage:
  share publish <src...> [--title T] [--dest SUBDIR] [--separate] [--ttl 24h] [--session ID]
  share extend  [SHARE_ID] [--by 24h]
  share expire  [SHARE_ID]
  share list    [--json] [--with-sessions]
  share url     [SHARE_ID]
  share purge   (--expired | SHARE_ID)
SHARE_ID defaults to the current Claude session's share.`;

class UsageError extends Error {}
class NoSession extends Error {}

const FLAGS_WITH_VALUE = new Set(['--title', '--dest', '--ttl', '--session', '--by']);
const BOOL_FLAGS = new Set(['--separate', '--json', '--with-sessions', '--expired']);

function parseArgs(argv) {
  const pos = []; const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (FLAGS_WITH_VALUE.has(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (BOOL_FLAGS.has(a)) opts[a.slice(2)] = true;
    else if (a.startsWith('--')) throw new UsageError(`unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, opts };
}

const local = formatLocal;
const left = (iso) => formatLeft(Date.parse(iso) - Date.now());

function currentSession(opts) {
  if (opts.session) return { sessionId: opts.session, cwd: process.cwd() };
  const s = findSession();
  if (!s) throw new NoSession('no Claude session found; pass --session ID (or run this from inside Claude Code)');
  return s;
}
const targetId = (pos, opts) => pos[0] || currentSession(opts).sessionId;

function publicView(s, withSessions, info) {
  const { token, ...rest } = s; // never print the raw token on its own
  const v = {
    ...rest, url: shareUrl(s), expired: isExpired(s),
    items: s.items.map(({ files, ...i }) => ({ ...i, url: itemUrl(s, i) })).reverse(),
  };
  if (withSessions) v.session = info.get(s.sessionId) || null;
  return v;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opts } = parseArgs(rest);
  switch (cmd) {
    case 'publish': {
      if (pos.length === 0) throw new UsageError('publish needs at least one file or folder');
      const ttlMs = opts.ttl ? parseDuration(opts.ttl) : DEFAULT_TTL_MS;
      const { sessionId, cwd } = currentSession(opts);
      const { share, item, warnings } = publish({
        srcs: pos, title: opts.title, dest: opts.dest, separate: Boolean(opts.separate), ttlMs, sessionId, projectPath: cwd,
      });
      for (const w of warnings) console.error(`warning: ${w}`);
      console.log(`Published "${item.title}" -> ${itemUrl(share, item)}`);
      console.log(`Share: ${shareUrl(share)}`);
      console.log(`Expires: ${local(share.expiresAt)} (${left(share.expiresAt)})`);
      return;
    }
    case 'extend': {
      const s = extendShare(targetId(pos, opts), parseDuration(opts.by || '24h'));
      console.log(`${shareUrl(s)}\nExpires: ${local(s.expiresAt)} (${left(s.expiresAt)})`);
      return;
    }
    case 'expire': {
      const s = expireShare(targetId(pos, opts));
      console.log(`Expired ${s.id} (files kept; "share extend ${s.id}" brings the link back)`);
      return;
    }
    case 'url': {
      const s = readShare(targetId(pos, opts));
      if (!s) throw new Error(`no such share: ${pos[0] || 'for this session'}`);
      console.log(shareUrl(s));
      return;
    }
    case 'list': {
      const shares = listShares();
      let info = new Map();
      if (opts['with-sessions']) {
        const { sessionInfo } = await import('./sessions.mjs');
        info = sessionInfo(shares.map((s) => s.sessionId));
      }
      const views = shares.map((s) => publicView(s, opts['with-sessions'], info));
      if (opts.json) { console.log(JSON.stringify(views, null, 2)); return; }
      if (views.length === 0) { console.log('no shares'); return; }
      for (const v of views) {
        console.log(`${v.id}${v.separate ? ' (separate)' : ''}  ${v.expired ? 'EXPIRED' : `expires ${local(v.expiresAt)}`}`);
        console.log(`  ${v.url}`);
        for (const i of v.items) console.log(`  - ${i.title}: ${i.url}`);
      }
      return;
    }
    case 'purge': {
      if (!opts.expired && !pos[0]) throw new UsageError('purge needs --expired or a SHARE_ID');
      const ids = purge(opts.expired ? { expired: true } : { id: pos[0] });
      console.log(ids.length ? `deleted: ${ids.join(' ')}` : 'nothing to delete');
      return;
    }
    case undefined: case '-h': case '--help': case 'help':
      console.log(USAGE);
      if (cmd === undefined) process.exitCode = 1;
      return;
    default:
      throw new UsageError(`unknown command "${cmd}"`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(`share: ${err.message}`);
  if (err instanceof UsageError) console.error(USAGE);
  process.exitCode = err instanceof NoSession ? 2 : 1;
});
