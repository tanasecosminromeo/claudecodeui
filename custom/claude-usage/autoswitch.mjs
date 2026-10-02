// Default account + auto-switch. decide() is pure (tests drive it); createController() adds the
// timer, state file, `claude-swap switch`, session-registry reads and the decision log around it.
// Spec: docs/superpowers/specs/2026-10-01-default-account-autoswitch-design.md
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LEAVE_5H = 99; // leave the account at this 5h percentage
export const PAUSE_7D = 95; // default at/over this 7-day pct: manual switches only
export const FAST_FROM = 90; // fast polling starts here (only while sessions are active)
export const VERY_FAST_FROM = 95;
export const FAST_MS = 30_000;
export const VERY_FAST_MS = 15_000;
export const COOLDOWN_MS = 5 * 60_000;
export const ACTIVE_WINDOW_MS = 5 * 60_000;
export const POST_SWITCH_MS = 60_000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

const pct5 = (a) => (a && a.fiveHour && typeof a.fiveHour.pct === 'number' ? a.fiveHour.pct : null);
const pct7 = (a) => (a && a.sevenDay && typeof a.sevenDay.pct === 'number' ? a.sevenDay.pct : null);

/** Next fast-poll delay for the active account, or null when no timer should run. */
export function pollDelay(activeAccount, hasActiveSessions) {
  if (!hasActiveSessions) return null;
  const p = pct5(activeAccount);
  if (p == null || p < FAST_FROM) return null;
  return p >= VERY_FAST_FROM ? VERY_FAST_MS : FAST_MS;
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
 * input: { accounts, defaultNumber, enabled, memory: { leftDefaultAt, defaultResetsAt, lastSwitchAt }, now, hasActiveSessions }
 * -> { action: 'none'|'switch'|'paused'|'blocked'|'unknown', to?, reason?, pollMs: number|null }
 */
export function decide({ accounts, defaultNumber, enabled, memory = {}, now, hasActiveSessions }) {
  const none = (extra = {}) => ({ action: 'none', pollMs: null, ...extra });
  if (!enabled || defaultNumber == null) return none();
  const def = accounts.find((a) => a.number === defaultNumber);
  const active = accounts.find((a) => a.active);
  if (!def || !active) return none();
  if (active.usageStatus !== 'ok' && def.usageStatus !== 'ok') return { action: 'unknown', pollMs: null, reason: 'usage unavailable' };

  const pollMs = pollDelay(active, hasActiveSessions);

  if (pct7(def) != null && pct7(def) >= PAUSE_7D) {
    return { action: 'paused', pollMs: null, reason: `Auto-switch paused: 7-day at ${Math.round(pct7(def))}%` };
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

export function createController({ stateDir, getUsage, switchTo, sessionsDir, now = () => Date.now(), pinnedToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN, setTimer = setTimeout, clearTimer = clearTimeout }) {
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');
  const logFile = path.join(stateDir, 'autoswitch.log');
  let state = { defaultAccount: null, enabled: true, leftDefaultAt: null, defaultResetsAt: null, lastSwitchAt: null };
  try { state = { ...state, ...JSON.parse(fs.readFileSync(stateFile, 'utf8')) }; } catch { /* first run */ }
  let timer = null;
  let lastNote = '';
  let last = { action: 'none', reason: null };
  let busy = false;

  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  function log(event, data = {}) {
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) fs.renameSync(logFile, `${logFile}.1`);
      fs.appendFileSync(logFile, `${JSON.stringify({ ts: new Date(now()).toISOString(), event, ...data })}\n`);
    } catch { /* logging must never break switching */ }
  }
  // state-change events only: identical consecutive notes are not repeated
  function note(event, data) {
    const key = `${event}:${data && data.reason}`;
    if (key !== lastNote) { lastNote = key; log(event, data); }
  }
  const usageSummary = (accounts) => accounts.map((a) => ({ number: a.number, active: a.active, fiveHour: pct5(a), sevenDay: pct7(a) }));

  async function tick() {
    if (busy) return last;
    busy = true;
    try {
      const data = await getUsage(false);
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
      const d = decide({ accounts: data.accounts || [], defaultNumber: state.defaultAccount, enabled: state.enabled && !pinnedToken, memory: state, now: now(), hasActiveSessions: hasActive });
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
      } else {
        lastNote = '';
      }
      // after a switch the old pollMs described the account we just left; the next event re-evaluates
      arm(d.action === 'switch' ? null : d.pollMs, hasActive);
      return d;
    } catch (err) {
      note('error', { reason: String(err.message || err) });
      return last;
    } finally { busy = false; }
  }

  function arm(ms, hasActive) {
    clearTimer(timer);
    timer = null;
    if (ms == null) { note('disarmed', { reason: hasActive ? 'below fast-poll threshold' : 'no active sessions' }); return; }
    note('armed', { reason: `${ms / 1000}s` });
    timer = setTimer(() => { timer = null; tick(); }, ms);
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
