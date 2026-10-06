// Status-file reading shared by the session list and the event watcher, and the
// rules that turn a status change into a push ("needs input", "finished", "failed").
import fs from 'node:fs';
import path from 'node:path';
import { procStartOf } from './detail.mjs';

export const STATE_RANK = { waiting: 0, busy: 1, idle: 2, other: 3, ended: 4 };
export const FINISH_MIN_MS = 3 * 60 * 1000; // shorter turns are not worth a buzz
const TAIL_BYTES = 64 * 1024;

// Live status files only: a dead pid, or a reused one (procStart differs), is skipped.
export function readStatusRecords(sessionsDir) {
  let files = [];
  try { files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
    if (!d || !d.sessionId || !d.pid) continue;
    const start = procStartOf(d.pid);
    if (!start || (d.procStart && String(d.procStart) !== start)) continue;
    const state = d.status === 'waiting' ? 'waiting' : d.status === 'busy' ? 'busy' : 'idle';
    out.push({ ...d, state });
  }
  return out;
}

// One entry per session: a session resumed in two terminals is waiting if either pid waits.
export function aggregateStates(records) {
  const out = new Map();
  for (const r of records) {
    const s = out.get(r.sessionId) || { state: 'ended', waitingFor: null, name: r.name || null, statusAt: 0 };
    if (STATE_RANK[r.state] < STATE_RANK[s.state]) { s.state = r.state; s.waitingFor = r.waitingFor || null; }
    s.statusAt = Math.max(s.statusAt, r.statusUpdatedAt || r.updatedAt || 0);
    out.set(r.sessionId, s);
  }
  return out;
}

export function findTranscript(projectsDir, sessionId) {
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const d of dirs) {
    const file = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

// Last main-thread assistant entry of a transcript; Claude Code marks a failed reply
// (rate limit, overload, auth) with isApiErrorMessage: true.
export function lastAssistantEntry(file) {
  if (!file) return null;
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
    fs.readSync(fd, buf, 0, buf.length, size - buf.length);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; } // blank, or cut in half by the tail read
    if (e.type !== 'assistant' || e.isSidechain) continue;
    const content = e.message && e.message.content;
    const body = Array.isArray(content)
      ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ')
      : typeof content === 'string' ? content : '';
    return { isApiError: e.isApiErrorMessage === true, text: body.replace(/\s+/g, ' ').trim().slice(0, 200) };
  }
  return null;
}

// busySince marks the start of a turn and survives permission prompts in the middle of it.
export function nextTracked(prev, next, now) {
  return { state: next.state, busySince: next.state === 'idle' ? null : (prev && prev.busySince != null ? prev.busySince : now) };
}

export function decideStatusEvent(prev, next, now, readLast) {
  if (next.state === 'waiting') {
    return prev && prev.state === 'waiting'
      ? null
      : { kind: 'action_required', code: 'session.waiting', meta: { waitingFor: next.waitingFor || null } };
  }
  if (next.state !== 'idle' || !prev || prev.state === 'idle') return null;
  const last = readLast();
  if (last && last.isApiError) return { kind: 'error', code: 'run.failed', meta: { error: last.text || 'API error' } };
  const ran = prev.busySince == null ? 0 : now - prev.busySince;
  if (ran < FINISH_MIN_MS) return null;
  return { kind: 'stop', code: 'run.stopped', meta: { stopReason: `Finished after ${Math.round(ran / 60000)} min` } };
}

// Numbered events for CloudCLI's relay to page through (GET /events?after=N).
export class EventLog {
  constructor(max = 200) { this.max = max; this.seq = 0; this.events = []; }
  push(e) {
    this.seq += 1;
    this.events.push({ seq: this.seq, at: Date.now(), ...e });
    if (this.events.length > this.max) this.events.shift();
  }
  after(seq) { return { seq: this.seq, events: this.events.filter((e) => e.seq > seq) }; }
}

// One call = one tick. The first tick only records state, so a restart does not
// re-announce sessions that were already waiting or busy.
export function createStatusWatcher({ readAggregated, readLast, log, now = Date.now }) {
  const known = new Map(); // sessionId -> { state, busySince }
  let primed = false;
  return function tick() {
    const t = now();
    const current = readAggregated();
    for (const [id, next] of current) {
      const prev = known.get(id);
      if (primed) {
        const ev = decideStatusEvent(prev, next, t, () => readLast(id));
        if (ev) log.push({ ...ev, sessionId: id, name: next.name || null });
      }
      // On the priming tick a busy session's turn is dated from its status file.
      known.set(id, nextTracked(prev, next, prev ? t : (next.statusAt || t)));
    }
    for (const id of [...known.keys()]) if (!current.has(id)) known.delete(id);
    primed = true;
  };
}
