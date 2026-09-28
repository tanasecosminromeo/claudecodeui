// Codex plan usage, read from the Codex CLI's own session logs ($CODEX_HOME/sessions/**/rollout-*.jsonl).
// Every Codex request appends a `token_count` event carrying the plan's `rate_limits` snapshot, so the
// newest one is the latest known usage: no credentials, no network. It is "as of the last Codex request":
// a window whose reset time has passed since then is reported as reset (0%).
import fs from 'node:fs';
import path from 'node:path';

const FILES_TO_SCAN = 8; // most recently written session files
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000; // older than the weekly window: nothing left to report

export function codexHome(env = process.env) {
  return env.CODEX_HOME || path.join(env.HOME || '', '.codex');
}

function rolloutFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
        try { out.push({ p, mtime: fs.statSync(p).mtimeMs }); } catch { /* vanished */ }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, FILES_TO_SCAN).map((f) => f.p);
}

function tailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // partial first line
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

// Newest rate_limits snapshot per limit_id ("codex", "premium", …) across the recent session files.
export function latestSnapshots(sessionsDir) {
  const latest = new Map();
  for (const file of rolloutFiles(sessionsDir)) {
    for (const line of tailLines(file)) {
      if (!line.includes('"token_count"') || !line.includes('"rate_limits"')) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const rl = event && event.payload && event.payload.type === 'token_count' ? event.payload.rate_limits : null;
      if (!rl || typeof rl !== 'object' || typeof event.timestamp !== 'string') continue;
      const id = typeof rl.limit_id === 'string' ? rl.limit_id : 'codex';
      const prev = latest.get(id);
      if (!prev || event.timestamp > prev.at) latest.set(id, { at: event.timestamp, rl });
    }
  }
  return latest;
}

function windowLabel(minutes) {
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return '7-day';
  return minutes % 1440 === 0 ? `${minutes / 1440}-day` : `${Math.round(minutes / 60)}-hour`;
}

export function countdown(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

function clock(date, now) {
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString('en-GB', { weekday: 'short' })} ${time}`;
}

// Same shape as claude-swap's windows, so the frontend renders both alike. Pace is judged at the time of
// the snapshot, the last moment the percentage is known, and only for day-plus windows: the 5-hour one
// doesn't start at a fixed time (76% can be "used" 7 minutes after its computed start).
export function toWindow(w, observedAt, now) {
  if (!w || typeof w !== 'object' || typeof w.used_percent !== 'number' || typeof w.window_minutes !== 'number') return null;
  const windowMs = w.window_minutes * 60000;
  const resetsAt = typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000) : null;
  const base = { name: windowLabel(w.window_minutes), windowMinutes: w.window_minutes, resetsAt: resetsAt ? resetsAt.toISOString() : null };
  if (resetsAt && resetsAt <= now) {
    return { ...base, pct: 0, resetSinceObserved: true, countdown: null, clock: null, expectedPct: null, aheadOfPace: null, willLastToReset: null, projectedExhaustionAt: null };
  }
  const pct = Math.max(0, Math.min(100, w.used_percent));
  const out = { ...base, pct, resetSinceObserved: false, countdown: resetsAt ? countdown(resetsAt - now) : null,
    clock: resetsAt ? clock(resetsAt, now) : null, expectedPct: null, aheadOfPace: null, willLastToReset: null, projectedExhaustionAt: null };
  if (resetsAt && w.window_minutes >= 1440) {
    const start = resetsAt.getTime() - windowMs;
    const elapsed = observedAt.getTime() - start;
    if (elapsed > 0 && elapsed < windowMs) {
      out.expectedPct = (elapsed / windowMs) * 100;
      out.aheadOfPace = pct > out.expectedPct;
      out.willLastToReset = pct === 0 || (pct / elapsed) * windowMs <= 100;
      if (!out.willLastToReset) out.projectedExhaustionAt = new Date(start + (100 / pct) * elapsed).toISOString();
    }
  }
  return out;
}

const humanize = (s) => (typeof s === 'string' && s ? s.replace(/_/g, ' ') : null);

// Whitelisted summary, or null when Codex isn't used on this machine (no recent snapshot).
export function readCodexUsage({ home = codexHome(), now = new Date() } = {}) {
  const sessions = path.join(home, 'sessions');
  if (!fs.existsSync(sessions)) return null;
  const snaps = latestSnapshots(sessions);
  if (snaps.size === 0) return null;
  const newest = Math.max(...[...snaps.values()].map((s) => Date.parse(s.at)));
  if (!(now - newest < MAX_AGE_MS)) return null;

  let planType = null;
  const limits = [...snaps.entries()]
    .sort(([a], [b]) => (a === 'codex' ? -1 : b === 'codex' ? 1 : a.localeCompare(b)))
    .map(([id, { at, rl }]) => {
      const observedAt = new Date(at);
      planType = planType || (typeof rl.plan_type === 'string' ? rl.plan_type : null);
      const credits = rl.credits && typeof rl.credits === 'object' ? {
        hasCredits: !!rl.credits.has_credits,
        unlimited: !!rl.credits.unlimited,
        balance: typeof rl.credits.balance === 'number' || typeof rl.credits.balance === 'string' ? rl.credits.balance : null,
      } : null;
      return {
        id,
        name: typeof rl.limit_name === 'string' && rl.limit_name ? rl.limit_name : id,
        observedAt: observedAt.toISOString(),
        primary: toWindow(rl.primary, observedAt, now),
        secondary: toWindow(rl.secondary, observedAt, now),
        reached: humanize(rl.rate_limit_reached_type),
        credits,
      };
    });
  return { planType, observedAt: new Date(newest).toISOString(), limits };
}
