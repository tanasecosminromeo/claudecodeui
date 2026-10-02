// @vitest-environment node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createController, decide, pollDelay, readSessions, COOLDOWN_MS } from '../autoswitch.mjs';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const acc = (number, five, seven, extra = {}) => ({
  number, active: false, usageStatus: 'ok',
  fiveHour: { pct: five, resetsAt: '2026-10-01T16:00:00Z' }, sevenDay: { pct: seven }, ...extra,
});
const run = (accounts, over = {}) => decide({ accounts, defaultNumber: 1, enabled: true, memory: {}, now: NOW, hasActiveSessions: true, ...over });
const on = (list, n) => list.map((a) => ({ ...a, active: a.number === n }));

describe('decide', () => {
  it('does nothing without a default or when disabled', () => {
    expect(run(on([acc(1, 99.5, 10), acc(2, 0, 0)], 1), { defaultNumber: null }).action).toBe('none');
    expect(run(on([acc(1, 99.5, 10), acc(2, 0, 0)], 1), { enabled: false }).action).toBe('none');
  });
  it('leaves the default at 99% for the fallback with most headroom', () => {
    const d = run(on([acc(1, 99, 10), acc(2, 40, 10), acc(3, 5, 10)], 1));
    expect(d).toMatchObject({ action: 'switch', to: 3, reason: 'default at 5h limit' });
  });
  it('stays put below 99%', () => {
    expect(run(on([acc(1, 98.9, 10), acc(2, 0, 0)], 1)).action).toBe('none');
  });
  it('skips targets that are exhausted, 7d-heavy, disabled or API-key; blocks when none is left', () => {
    const list = on([acc(1, 99, 10), acc(2, 0, 96), acc(3, 0, 0, { disabled: true }), acc(4, 0, 0, { apiKey: true }), acc(5, 99, 0)], 1);
    expect(run(list)).toMatchObject({ action: 'blocked' });
  });
  it('chains from a fallback at 99%, back to the default if it has headroom', () => {
    const d = run(on([acc(1, 10, 10), acc(2, 99, 10)], 2), { memory: { leftDefaultAt: NOW - 1000 } });
    expect(d).toMatchObject({ action: 'switch', to: 1, reason: 'fallback at 5h limit' });
  });
  it('returns to the default once the window it left has reset', () => {
    const list = on([acc(1, 3, 20), acc(2, 30, 10)], 2);
    const memory = { leftDefaultAt: NOW - 3 * 3600e3, defaultResetsAt: '2026-10-01T11:00:00Z' };
    expect(run(list, { memory })).toMatchObject({ action: 'switch', to: 1, reason: 'default 5h window reset' });
  });
  it('does not return before the reset, nor after a manual move with no window to wait for', () => {
    const list = on([acc(1, 3, 20), acc(2, 30, 10)], 2);
    expect(run(list, { memory: { leftDefaultAt: NOW - 1000, defaultResetsAt: '2026-10-01T16:00:00Z' } }).action).toBe('none');
    expect(run(list, { memory: { leftDefaultAt: NOW - 1000, defaultResetsAt: null } }).action).toBe('none');
  });
  it('pauses everything when the default is at 95% on 7 days, with the message', () => {
    const d = run(on([acc(1, 99.5, 95), acc(2, 0, 0)], 1));
    expect(d).toMatchObject({ action: 'paused', reason: 'Auto-switch paused: 7-day at 95%' });
    expect(run(on([acc(1, 3, 96), acc(2, 30, 10)], 2), { memory: { leftDefaultAt: 1, defaultResetsAt: '2026-10-01T11:00:00Z' } }).action).toBe('paused');
  });
  it('respects the cooldown', () => {
    expect(run(on([acc(1, 99.5, 10), acc(2, 0, 0)], 1), { memory: { lastSwitchAt: NOW - COOLDOWN_MS + 1000 } }).action).toBe('none');
  });
});

describe('pollDelay: quiet unless there is activity', () => {
  const a = (p) => acc(1, p, 0);
  it('96% and nothing active: no timer at all', () => expect(pollDelay(a(96), false)).toBeNull());
  it('below 90%: no timer even with sessions', () => expect(pollDelay(a(89), true)).toBeNull());
  it('90-95% with sessions: 30s; 95%+: 15s', () => {
    expect(pollDelay(a(92), true)).toBe(30_000);
    expect(pollDelay(a(96), true)).toBe(15_000);
  });
});

describe('readSessions', () => {
  it('counts live busy/waiting/recent processes as active, ignores dead pids and junk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-'));
    const w = (name, o) => fs.writeFileSync(path.join(dir, name), typeof o === 'string' ? o : JSON.stringify(o));
    w('a.json', { pid: process.pid, status: 'busy', statusUpdatedAt: 0, sessionId: 's1' });
    w('b.json', { pid: process.pid, status: 'idle', statusUpdatedAt: NOW - 3600e3 });
    w('c.json', { pid: 2 ** 22 + 12345, status: 'busy' });
    w('d.json', '{half');
    w('e.json', { peerToken: 'x' });
    const list = readSessions(dir, NOW);
    expect(list.map((s) => s.active)).toEqual([true, false]);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('controller over time (injected clock, faked report)', () => {
  let dir; let clock; let usage; let active; let calls; let timers; let ctl;
  const mk = (sessions = []) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctl-'));
    const sdir = path.join(dir, 'sessions');
    fs.mkdirSync(sdir);
    sessions.forEach((s, i) => fs.writeFileSync(path.join(sdir, `${i}.json`), JSON.stringify(s)));
    clock = NOW; active = 1; calls = []; timers = [];
    usage = { 1: [50, 20, '2026-10-01T15:00:00Z'], 2: [10, 10, null] };
    ctl = createController({
      stateDir: path.join(dir, 'state'), sessionsDir: sdir, now: () => clock, pinnedToken: false,
      getUsage: async () => ({ accounts: [1, 2].map((n) => ({ number: n, active: active === n, usageStatus: 'ok', fiveHour: { pct: usage[n][0], resetsAt: usage[n][2] }, sevenDay: { pct: usage[n][1] } })) }),
      switchTo: async (n) => { calls.push(n); active = n; },
      setTimer: (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; }, clearTimer: (h) => { if (h) h.cleared = true; },
    });
  };
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('leaves at 99%, waits out the window, returns after the reset and clears its memory', async () => {
    mk();
    ctl.setDefault({ defaultAccount: 1 });
    usage[1] = [99.2, 20, '2026-10-01T15:00:00Z'];
    await ctl.tick();
    expect(calls).toEqual([2]);
    clock += COOLDOWN_MS + 1000; // before the window resets: stay on #2
    usage[1] = [99.2, 20, '2026-10-01T15:00:00Z'];
    await ctl.tick();
    expect(calls).toEqual([2]);
    clock = Date.parse('2026-10-01T15:00:05Z'); // the default's window rolled over
    usage[1] = [2, 20, null];
    await ctl.tick();
    expect(calls).toEqual([2, 1]);
    const events = ctl.readLog().map((l) => l.event);
    expect(events.filter((e) => e === 'switch')).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'state', 'state.json'), 'utf8'))).toMatchObject({ leftDefaultAt: null, defaultResetsAt: null });
  });

  it('a manual move off the default is not undone, even though the default is nearly empty', async () => {
    mk();
    ctl.setDefault({ defaultAccount: 1 });
    usage[1] = [5, 20, '2026-10-01T15:00:00Z'];
    active = 2; // user switched by hand
    await ctl.tick();
    clock += COOLDOWN_MS + 1000;
    await ctl.tick();
    expect(calls).toEqual([]);
    clock = Date.parse('2026-10-01T15:00:05Z'); // ...until the default's window has rolled over
    usage[1] = [0, 20, null];
    await ctl.tick();
    expect(calls).toEqual([1]);
  });

  it('96% with nothing active arms no timer; with a busy session it arms 15s', async () => {
    mk([{ pid: process.pid, status: 'idle', statusUpdatedAt: NOW - 3600e3 }]);
    ctl.setDefault({ defaultAccount: 1 });
    usage[1] = [96, 20, '2026-10-01T15:00:00Z'];
    await ctl.tick();
    expect(timers.filter((t) => !t.cleared)).toHaveLength(0);
    fs.writeFileSync(path.join(dir, 'sessions', '0.json'), JSON.stringify({ pid: process.pid, status: 'busy' }));
    await ctl.tick();
    expect(timers.filter((t) => !t.cleared).map((t) => t.ms)).toEqual([15_000]);
    fs.writeFileSync(path.join(dir, 'sessions', '0.json'), JSON.stringify({ pid: process.pid, status: 'idle', statusUpdatedAt: NOW - 3600e3 }));
    await ctl.tick(); // work stopped: the timer is cancelled, nothing re-armed
    expect(timers.filter((t) => !t.cleared)).toHaveLength(0);
  });
});

// ---- the real server against a fake claude-swap whose report we script ----
const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const FAKE = `#!/bin/sh
d="$HOME/fake"
[ -f "$d/active" ] || echo 1 > "$d/active"
a=$(cat "$d/active")
case "$1" in
  list) sed "s/__ACTIVE__/$a/; s/\\"active\\":__A1__/\\"active\\":$([ "$a" = 1 ] && echo true || echo false)/; s/\\"active\\":__A2__/\\"active\\":$([ "$a" = 2 ] && echo true || echo false)/" "$d/report.json" ;;
  switch) echo "$2" > "$d/active"; echo "$2" >> "$d/switches" ;;
esac
`;

describe('server with a faked claude-swap report', () => {
  let home; let proc; let base;
  const report = (a1five, a1seven, a2five, a2seven) => fs.writeFileSync(path.join(home, 'fake', 'report.json'), JSON.stringify({
    activeAccountNumber: '__ACTIVE__',
    accounts: [
      { number: 1, email: 'small@example.com', active: '__A1__', usageStatus: 'ok', usage: { fiveHour: { pct: a1five, resetsAt: '2026-10-01T16:00:00Z' }, sevenDay: { pct: a1seven } } },
      { number: 2, email: 'max@example.com', active: '__A2__', usageStatus: 'ok', usage: { fiveHour: { pct: a2five }, sevenDay: { pct: a2seven } } },
    ],
  }).replace('"__ACTIVE__"', '__ACTIVE__').replaceAll('"__A1__"', '__A1__').replaceAll('"__A2__"', '__A2__'));
  const switches = () => { try { return fs.readFileSync(path.join(home, 'fake', 'switches'), 'utf8').trim().split('\n'); } catch { return []; } };
  const get = async (p, o) => (await fetch(`${base}${p}`, o)).json();
  const put = (body) => get('/default', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-usage-auto-'));
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, 'fake'));
    fs.mkdirSync(path.join(home, 'sessions'));
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude-swap'), FAKE, { mode: 0o755 });
    report(50, 20, 10, 10);
    proc = spawn(process.execPath, [SERVER], {
      env: { PATH: process.env.PATH, HOME: home, CLAUDE_USAGE_SESSIONS_DIR: path.join(home, 'sessions'), CLAUDE_USAGE_TTL_MS: '1' }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    const ready = await new Promise((resolve, reject) => {
      proc.stdout.once('data', (c) => resolve(JSON.parse(String(c))));
      proc.once('exit', (code) => reject(new Error(`server exited ${code}`)));
    });
    base = `http://127.0.0.1:${ready.port}`;
  });
  afterAll(() => { proc.kill(); fs.rmSync(home, { recursive: true, force: true }); });

  it('with no default set, a 100% report switches nothing', async () => {
    report(100, 20, 10, 10);
    const u = await get('/usage?refresh=1');
    expect(u.auto.defaultAccount).toBeNull();
    expect(switches()).toEqual([]);
  });

  it('default at 99.5% 5h: switches to #2, logs why, with the live sessions', async () => {
    fs.writeFileSync(path.join(home, 'sessions', '1.json'), JSON.stringify({ pid: process.pid, status: 'busy', entrypoint: 'cli', sessionId: 'abc' }));
    report(99.5, 20, 10, 10);
    await put({ defaultAccount: 1 }); // PUT runs a check
    expect(switches()).toEqual(['2']);
    const log = await get('/autoswitch/log');
    const sw = log.find((l) => l.event === 'switch');
    expect(sw).toMatchObject({ reason: 'default at 5h limit', from: 1, to: 2, ok: true });
    expect(sw.sessions[0]).toMatchObject({ entrypoint: 'cli', sessionId: 'abc', status: 'busy' });
    expect(sw.usage.find((a) => a.number === 1).fiveHour).toBe(99.5);
    expect(JSON.stringify(log)).not.toMatch(/token/i);
  });

  it('the cooldown stops an immediate second switch', async () => {
    report(10, 20, 10, 10);
    await get('/usage?refresh=1');
    await get('/usage?refresh=1');
    expect(switches()).toEqual(['2']);
  });

  it('default at 7d 95%: paused, message shown, still no switches', async () => {
    report(99.9, 95, 10, 10);
    await put({ defaultAccount: 2 });
    await put({ defaultAccount: 1 });
    const u = await get('/usage?refresh=1');
    expect(u.auto.paused).toBe('Auto-switch paused: 7-day at 95%');
    expect(switches()).toEqual(['2']);
    expect((await get('/autoswitch/log')).some((l) => l.event === 'paused')).toBe(true);
  });

  it('rejects an unknown default', async () => {
    const res = await fetch(`${base}/default`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultAccount: 9 }) });
    expect(res.status).toBe(400);
  });
});
