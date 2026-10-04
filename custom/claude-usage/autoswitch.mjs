// Default account + auto-switch. decide() is pure (tests drive it); createController() adds the
// timer, state file, `claude-swap switch`, session-registry reads and the decision log around it.
// Spec: docs/superpowers/specs/2026-10-01-default-account-autoswitch-design.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LEAVE_5H = 95; // leave the account at this 5h percentage
export const PAUSE_7D = 95; // default at/over this 7-day pct: manual switches only
export const WATCH_FROM = 90; // from here, while sessions are active, re-check each time claude-swap's usage cache expires
export const CACHE_TTL_S = 180; // claude-swap serves usage up to this old (poll_policy.SERVE_TTL_S); asking sooner reads the same numbers
export const RECHECK_SLACK_MS = 5_000; // wait this long past the expiry, so the call lands on a refreshed cache
export const MIN_RECHECK_MS = 10_000;
export const RETRY_MS = 30_000; // the cache should have refreshed but didn't (fetch failing): try again
export const COOLDOWN_MS = 5 * 60_000;
export const ACTIVE_WINDOW_MS = 5 * 60_000;
export const POST_SWITCH_MS = 60_000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

const pct5 = (a) => (a && a.fiveHour && typeof a.fiveHour.pct === 'number' ? a.fiveHour.pct : null);
const pct7 = (a) => (a && a.sevenDay && typeof a.sevenDay.pct === 'number' ? a.sevenDay.pct : null);

// Log times are local (Europe/Bucharest, EEST/EET) with their offset, so they read as wall-clock time and still parse.
const LOG_TZ = 'Europe/Bucharest';
export function localIso(at) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: LOG_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset' })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.slice(3);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

/**
 * When the 5h window runs out at the pace averaged since it opened (claude-swap's own formula; it only
 * reports this for the 7-day windows). Bursty use beats it: a busy last few minutes are averaged away.
 */
export function projected5h(a) {
  const pct = pct5(a);
  const reset = a && a.fiveHour ? Date.parse(a.fiveHour.resetsAt) : NaN;
  const at = a ? Date.parse(a.usageFetchedAt) : NaN;
  if (pct == null || pct <= 0 || !Number.isFinite(reset) || !Number.isFinite(at)) return null;
  const elapsed = 5 * 3600e3 - (reset - at);
  if (elapsed <= 0) return null;
  return pct >= 100 ? at : at + (100 - pct) / (pct / elapsed);
}

/**
 * When to look again: just after claude-swap's cached usage expires, so the call gets fresh numbers.
 * null = no timer (nothing active, or the account is far from its limit): the next UI fetch or new session checks.
 * ageS = how old the active account's usage already is.
 */
export function pollDelay(activeAccount, hasActiveSessions, ageS) {
  if (!hasActiveSessions) return null;
  const p = pct5(activeAccount);
  if (p == null || p < WATCH_FROM) return null;
  if (typeof ageS !== 'number' || !Number.isFinite(ageS)) return 60_000;
  if (ageS >= CACHE_TTL_S) return RETRY_MS;
  return Math.max(MIN_RECHECK_MS, (CACHE_TTL_S - ageS) * 1000 + RECHECK_SLACK_MS);
}

// ---- reactive safety net: a session of ours hit "You've hit your session limit · resets 8:10pm (Europe/Bucharest)" ----
const RESETS_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap])m\s*\(([^)]+)\)/i;
function minutesOfDay(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  return Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
}
/** Does this error text describe the 5-hour window of an account whose window resets at resetsAt? */
export function limitMatches(text, resetsAt) {
  const m = RESETS_RE.exec(String(text || ''));
  if (!m || !/session limit/i.test(text) || !resetsAt) return false;
  const when = new Date(resetsAt);
  if (Number.isNaN(when.getTime())) return false;
  try {
    const want = ((Number(m[1]) % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + Number(m[2] || 0);
    const diff = Math.abs(minutesOfDay(when, m[4]) - want);
    return Math.min(diff, 1440 - diff) <= 1; // claude-swap's resetsAt carries seconds; the message rounds to the minute
  } catch { return false; } // unknown time zone name
}

/** rate_limit errors written to recent transcripts since `since` (ms): [{ ts, text }], newest last. */
export function findRateLimitHits(projectsDir, since, now) {
  const hits = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return hits; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(projectsDir, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(projectsDir, d, f);
      try {
        const st = fs.statSync(file);
        if (now - st.mtimeMs > 15 * 60_000 || st.mtimeMs < since) continue;
        const len = Math.min(st.size, 256 * 1024);
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        fs.closeSync(fd);
        for (const line of buf.toString('utf8').split('\n')) {
          if (!line.includes('rate_limit')) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          const ts = Date.parse(j.timestamp);
          if (j.error !== 'rate_limit' || !j.isApiErrorMessage || !(ts > since)) continue;
          const c = j.message && j.message.content;
          const text = Array.isArray(c) ? c.map((x) => x && x.text).filter(Boolean).join(' ') : String(c || '');
          hits.push({ ts, text });
        }
      } catch { /* file vanished or unreadable */ }
    }
  }
  return hits.sort((x, y) => x.ts - y.ts);
}

function bestTarget(accounts, exceptNumber) {
  const usable = accounts.filter((a) => a.number !== exceptNumber && !a.disabled && !a.apiKey
    && a.usageStatus === 'ok' && !(pct7(a) != null && pct7(a) >= PAUSE_7D) && !(pct5(a) != null && pct5(a) >= LEAVE_5H));
  usable.sort((x, y) => (pct5(x) ?? 100) - (pct5(y) ?? 100));
  return usable[0] || null;
}

// The default's 5h window has rolled over since we left it: the resetsAt we recorded then has passed.
// No recorded resetsAt (the default was idle when we left) means a deliberate move: never auto-return.
function defaultReset(memory, now) {
  const resets = memory.defaultResetsAt ? Date.parse(memory.defaultResetsAt) : NaN;
  return memory.leftDefaultAt != null && Number.isFinite(resets) && now >= resets;
}

/**
 * input: { accounts, defaultNumber, enabled, memory: { leftDefaultAt, defaultResetsAt, lastSwitchAt }, now, hasActiveSessions, ageS, limitHit }
 * -> { action: 'none'|'switch'|'paused'|'blocked'|'unknown', to?, reason?, pollMs: number|null }
 */
export function decide({ accounts, defaultNumber, enabled, memory = {}, now, hasActiveSessions, ageS, limitHit = false }) {
  const none = (extra = {}) => ({ action: 'none', pollMs: null, ...extra });
  if (!enabled || defaultNumber == null) return none();
  const def = accounts.find((a) => a.number === defaultNumber);
  const active = accounts.find((a) => a.active);
  if (!def || !active) return none();
  if (active.usageStatus !== 'ok' && def.usageStatus !== 'ok') return { action: 'unknown', pollMs: null, reason: 'usage unavailable' };

  const pollMs = pollDelay(active, hasActiveSessions, ageS);

  if (pct7(def) != null && pct7(def) >= PAUSE_7D) {
    return { action: 'paused', pollMs: null, reason: `Auto-switch paused: 7-day at ${Math.round(pct7(def))}%` };
  }
  // a session already got the limit error: the account is spent whatever the (stale) numbers say, and the cooldown must not hold us on it
  if (limitHit) {
    const target = bestTarget(accounts, active.number);
    if (!target) return { action: 'blocked', pollMs, reason: `rate-limit error on #${active.number} and no usable target` };
    return { action: 'switch', to: target.number, reason: 'rate-limit error in a session', pollMs };
  }
  if (memory.lastSwitchAt && now - memory.lastSwitchAt < COOLDOWN_MS) return none({ pollMs, reason: 'cooldown' });

  if (pct5(active) != null && pct5(active) >= LEAVE_5H) {
    const target = bestTarget(accounts, active.number);
    if (!target) return { action: 'blocked', pollMs, reason: `account #${active.number} at ${Math.round(pct5(active))}% and no usable target` };
    const reason = active.number === def.number ? 'default at 5h limit' : 'fallback at 5h limit';
    return { action: 'switch', to: target.number, reason, pollMs };
  }

  if (active.number !== def.number && def.usageStatus === 'ok' && defaultReset(memory, now)) {
    return { action: 'switch', to: def.number, reason: 'default 5h window reset', pollMs };
  }
  return none({ pollMs });
}

// ---- session registry: which Claude processes are doing something right now ----
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

export function readSessions(dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions'), now = Date.now()) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!d || !Number.isInteger(d.pid) || !alive(d.pid)) continue;
      const at = d.statusUpdatedAt || d.updatedAt || 0;
      const active = d.status === 'busy' || d.status === 'waiting' || (at && now - at < ACTIVE_WINDOW_MS);
      out.push({ pid: d.pid, entrypoint: d.entrypoint || null, sessionId: d.sessionId || null, status: d.status || 'idle', active: !!active });
    } catch { /* half-written registry file */ }
  }
  return out;
}

export function createController({ stateDir, getUsage, switchTo, sessionsDir, projectsDir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'), now = () => Date.now(), pinnedToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN, setTimer = setTimeout, clearTimer = clearTimeout }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  const logFile = path.join(stateDir, 'autoswitch.log');
  let state = { defaultAccount: null, enabled: true, leftDefaultAt: null, defaultResetsAt: null, lastSwitchAt: null, lastHitAt: 0 };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first run */ }
  if (!state.lastHitAt) state.lastHitAt = now(); // errors from before we started watching are history
  let timer = null;
  let lastNote = '';
  let lastReadingAt = null;
  let last = { action: 'none', reason: null };
  let busy = false;

  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  function log(event, data = {}) {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, `${logFile}.1`);
      fs.appendFileSync(logFile, `${JSON.stringify({ ts: localIso(now()), event, ...data })}\n`);
    } catch { /* logging must never break switching */ }
  }
  // state-change events only: identical consecutive notes are not repeated
  function note(event, data) {
    const key = `${event}:${data && data.reason}`;
    if (key !== lastNote) { lastNote = key; log(event, data); }
  }
  const usageSummary = (accounts) => accounts.map((a) => {
    const eta5 = projected5h(a);
    return {
      number: a.number,
      active: a.active,
      fiveHour: pct5(a),
      fiveHourResetsAt: a.fiveHour && a.fiveHour.resetsAt ? localIso(a.fiveHour.resetsAt) : null,
      fiveHourProjectedExhaustionAt: eta5 == null ? null : localIso(eta5),
      sevenDay: pct7(a),
      sevenDayProjectedExhaustionAt: a.sevenDay && a.sevenDay.projectedExhaustionAt ? localIso(a.sevenDay.projectedExhaustionAt) : null,
      measuredAt: a.usageFetchedAt ? localIso(a.usageFetchedAt) : null,
    };
  });

  async function tick(force = false) {
    if (busy) return last;
    busy = true;
    try {
      const data = await getUsage(force);
      const sessions = readSessions(sessionsDir, now());
      const hasActive = sessions.some((s) => s.active);
      const accounts = data.accounts || [];
      const def = accounts.find((a) => a.number === state.defaultAccount);
      const cur = accounts.find((a) => a.active);
      // a move off the default (manual or ours) starts "away"; being on it ends it
      if (def && cur && cur.number !== def.number && state.leftDefaultAt == null) {
        state.leftDefaultAt = now();
        state.defaultResetsAt = (def.fiveHour && def.fiveHour.resetsAt) || null;
        save();
      } else if (def && cur && cur.number === def.number && state.leftDefaultAt != null) {
        state.leftDefaultAt = null;
        state.defaultResetsAt = null;
        save();
      }
      // how old the active account's numbers are: claude-swap's own age plus the time they sat in our cache
      const ageS = cur && typeof cur.usageAgeSeconds === 'number' ? cur.usageAgeSeconds + Math.max(0, (now() - Date.parse(data.fetchedAt)) / 1000) : undefined;
      // a rate-limit error counts only when its reset time is the active account's window; one from a session still on the other account says nothing about this one
      let limitHit = false;
      if (state.defaultAccount != null && cur && cur.fiveHour && cur.fiveHour.resetsAt) {
        const hits = findRateLimitHits(projectsDir, state.lastHitAt || 0, now());
        const mine = hits.filter((h) => limitMatches(h.text, cur.fiveHour.resetsAt));
        if (mine.length) { limitHit = true; state.lastHitAt = mine[mine.length - 1].ts; }
      }
      const d = decide({ accounts, defaultNumber: state.defaultAccount, enabled: state.enabled && !pinnedToken, memory: state, now: now(), hasActiveSessions: hasActive, ageS, limitHit });
      last = d;
      if (d.action === 'switch') {
        const from = (data.accounts || []).find((a) => a.active);
        let result = { ok: true };
        try { await switchTo(d.to); } catch (err) { result = { ok: false, error: String(err.message || err) }; }
        state.lastSwitchAt = now();
        if (result.ok) {
          if (from && from.number === state.defaultAccount) { state.leftDefaultAt = now(); state.defaultResetsAt = (from.fiveHour && from.fiveHour.resetsAt) || null; }
          if (d.to === state.defaultAccount) { state.leftDefaultAt = null; state.defaultResetsAt = null; }
        }
        save();
        log('switch', { reason: d.reason, from: from ? from.number : null, to: d.to, ok: result.ok, error: result.error, usage: usageSummary(data.accounts), sessions });
        if (result.ok) setTimer(() => log('post-switch', { activeAccount: d.to, sessions: readSessions(sessionsDir, now()) }), POST_SWITCH_MS).unref?.();
        lastNote = '';
      } else if (d.action === 'paused' || d.action === 'blocked' || d.action === 'unknown') {
        note(d.action, { reason: d.reason, usage: usageSummary(data.accounts) });
      }
      // after a switch the old pollMs described the account we just left; the next event re-evaluates
      // near the limit, every new claude-swap measurement goes in the log: the run-up to a switch (or a miss) can be replayed
      if (cur && pct5(cur) != null && pct5(cur) >= WATCH_FROM && cur.usageFetchedAt && cur.usageFetchedAt !== lastReadingAt) {
        lastReadingAt = cur.usageFetchedAt;
        log('reading', { activeAccount: cur.number, usageAgeS: ageS == null ? null : Math.round(ageS), usage: usageSummary(accounts), activeSessions: sessions.filter((s) => s.active).length });
      }
      arm(d.action === 'switch' ? null : d.pollMs, hasActive, ageS);
      return d;
    } catch (err) {
      note('error', { reason: String(err.message || err) });
      return last;
    } finally { busy = false; }
  }

  function arm(ms, hasActive, ageS) {
    clearTimer(timer);
    timer = null;
    if (ms == null) { note('disarmed', { reason: hasActive ? 'below watch threshold' : 'no active sessions' }); return; }
    note('armed', { reason: 'next check after the usage cache expires', inMs: ms, usageAgeS: ageS == null ? null : Math.round(ageS) });
    timer = setTimer(() => { timer = null; tick(true); }, ms);
    timer.unref?.();
  }

  return {
    tick,
    status: () => ({ defaultAccount: state.defaultAccount, enabled: state.enabled, pinnedToken, paused: last.action === 'paused' ? last.reason : null, lastAction: last.action }),
    setDefault({ defaultAccount, enabled }) {
      if (defaultAccount !== undefined) { state.defaultAccount = defaultAccount; state.leftDefaultAt = null; state.defaultResetsAt = null; }
      if (enabled !== undefined) state.enabled = !!enabled;
      save();
      log('config', { defaultAccount: state.defaultAccount, enabled: state.enabled });
    },
    readLog(n = 200) {
      try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l)); } catch { return []; }
    },
    stop() { clearTimer(timer); timer = null; },
  };
}
