// @vitest-environment node
import { expect, it as test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { killLeftovers, leftoversFor, listLeftovers } from '../leftovers.mjs';

// A fake /proc, a fake cgroup tree and a fake records dir, so nothing real is listed or signalled.
const BOOT_S = 1_700_000_000;
const NOW = (BOOT_S + 100_000) * 1000; // 100000 s after boot
const AGED = 'cloudcli-claude-aaaaaaaa-1111-2222-3333-444444444444-AAAAAA.scope';
const LIVE = 'cloudcli-claude-bbbbbbbb-1111-2222-3333-444444444444-BBBBBB.scope';
const DEAD = 'cloudcli-claude-cccccccc-1111-2222-3333-444444444444-CCCCCC.scope';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-leftovers-'));
  const f = {
    root,
    cgroupRoot: path.join(root, 'app.slice'),
    recordsDir: path.join(root, 'claude-processes'),
    procRoot: path.join(root, 'proc'),
  };
  fs.mkdirSync(f.cgroupRoot, { recursive: true });
  fs.mkdirSync(f.recordsDir, { recursive: true });
  fs.mkdirSync(f.procRoot, { recursive: true });
  fs.writeFileSync(path.join(f.procRoot, 'stat'), `cpu 1 2 3\nbtime ${BOOT_S}\n`);
  // A process: start is in clock ticks after boot (100 per second). Fields after ')' as in /proc/<pid>/stat.
  f.proc = (pid, { ppid = 1, startSec = 1000, name = 'worker', argv = [name], rssKb = 2048 } = {}) => {
    const dir = path.join(f.procRoot, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    const rest = ['S', String(ppid), ...Array(17).fill('0'), String(startSec * 100)].join(' ');
    fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${name}) ${rest}\n`);
    fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
    fs.writeFileSync(path.join(dir, 'status'), `Name:\t${name}\nVmRSS:\t${rssKb} kB\n`);
  };
  f.scope = (unit, pids, sub = {}) => {
    const dir = path.join(f.cgroupRoot, unit);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cgroup.procs'), pids.map((p) => `${p}\n`).join(''));
    for (const [name, list] of Object.entries(sub)) {
      const d = path.join(dir, name);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'cgroup.procs'), list.map((p) => `${p}\n`).join(''));
    }
    return dir;
  };
  f.record = (name, { pid, procStart, unit }) => {
    const dir = path.join(f.recordsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ appSessionId: name, pid, procStart: String(procStart), unit }));
  };
  f.deps = (extra = {}) => ({
    cgroupRoot: f.cgroupRoot, recordsDir: f.recordsDir, procRoot: f.procRoot, now: NOW, minAgeMs: 30000, ...extra,
  });
  return f;
}

test('excludes a scope whose record names a live process with the same start time', () => {
  const f = fixture();
  f.proc(400, { startSec: 1000, name: 'claude' });
  f.scope(LIVE, [400]);
  f.record('live', { pid: 400, procStart: 1000 * 100, unit: LIVE.replace(/\.scope$/, '') });
  expect(listLeftovers(f.deps())).toEqual([]);
  fs.rmSync(f.root, { recursive: true });
});

test('includes a scope whose recorded process has ended', () => {
  const f = fixture();
  f.proc(402, { startSec: 1000, name: 'opencode' });
  f.scope(DEAD, [402]);
  f.record('dead', { pid: 401, procStart: 1000 * 100, unit: DEAD.replace(/\.scope$/, '') });
  const groups = listLeftovers(f.deps());
  expect(groups.map((g) => g.unit)).toEqual([DEAD]);
  expect(groups[0]).toMatchObject({ appSessionId: 'cccccccc-1111-2222-3333-444444444444' });
  expect(groups[0].processes).toHaveLength(1);
  expect(groups[0].processes[0]).toMatchObject({ pid: 402, ppid: 1, depth: 0, name: 'opencode', procStart: String(1000 * 100) });
  fs.rmSync(f.root, { recursive: true });
});

test('a reused pid (other start time) does not keep a scope alive', () => {
  const f = fixture();
  f.proc(410, { startSec: 1000 });
  f.scope(DEAD, [410]);
  f.record('reused', { pid: 410, procStart: 555, unit: DEAD.replace(/\.scope$/, '') });
  expect(listLeftovers(f.deps()).map((g) => g.unit)).toEqual([DEAD]);
  fs.rmSync(f.root, { recursive: true });
});

test('skips an empty scope, a non-scope directory, and a scope younger than minAgeMs', () => {
  const f = fixture();
  f.scope(DEAD, []);
  f.scope('session-1.scope', [420]);
  f.proc(420, { startSec: 1000 });
  f.proc(421, { startSec: NOW / 1000 - BOOT_S - 10 }); // started 10 s before "now"
  f.scope(LIVE, [421]);
  expect(listLeftovers(f.deps())).toEqual([]);
  expect(listLeftovers(f.deps({ minAgeMs: 5000 })).map((g) => g.unit)).toEqual([LIVE]);
  fs.rmSync(f.root, { recursive: true });
});

test('counts processes in child cgroups and orders them as a tree', () => {
  const f = fixture();
  f.proc(500, { startSec: 1000, name: 'sh' });
  f.proc(501, { ppid: 500, startSec: 1010, name: 'pwa' });
  f.proc(502, { ppid: 501, startSec: 1020, name: 'opencode' });
  f.proc(503, { ppid: 500, startSec: 1030, name: 'socat' }); // later sibling of 501
  f.proc(504, { ppid: 9999, startSec: 1040, name: 'orphan' }); // parent outside the scope: a root
  f.scope(AGED, [500], { 'child.slice': [501, 502, 503, 504] });
  const [g] = listLeftovers(f.deps());
  expect(g.processes.map((p) => p.pid)).toEqual([500, 501, 502, 503, 504]);
  expect(g.processes.map((p) => p.depth)).toEqual([0, 1, 2, 1, 0]);
  expect(g.processes[1]).toMatchObject({ command: 'pwa', name: 'pwa', rssBytes: 2048 * 1024 });
  expect(g.startedAt).toBe((BOOT_S + 1000) * 1000);
  fs.rmSync(f.root, { recursive: true });
});

test('leftoversFor labels a group from the session row, with the short id as fallback', () => {
  const f = fixture();
  f.proc(600, { startSec: 1000, name: 'tunnel' });
  f.scope(AGED, [600]);
  f.proc(601, { startSec: 1000, name: 'other' });
  f.scope(DEAD, [601]);
  const labelFor = (ids) => new Map(ids.filter((id) => id.startsWith('aaaa')).map((id) => [id, { name: ' Tunnel work ', projectName: 'claudecodeui' }]));
  const out = leftoversFor({ serverStartedAt: 42, labelFor, ...f.deps() });
  expect(out.serverStartedAt).toBe(42);
  const byId = Object.fromEntries(out.groups.map((g) => [g.appSessionId, g]));
  expect(byId['aaaaaaaa-1111-2222-3333-444444444444']).toMatchObject({ title: 'Tunnel work', project: 'claudecodeui' });
  expect(byId['cccccccc-1111-2222-3333-444444444444']).toMatchObject({ title: 'cccccccc', project: null });
  fs.rmSync(f.root, { recursive: true });
});

// ---- kill (the POST /leftovers/kill logic) ----

function killFixture() {
  const f = fixture();
  f.proc(700, { startSec: 1000, name: 'sh' });
  f.proc(701, { ppid: 700, startSec: 1010, name: 'dev-server' });
  f.proc(702, { ppid: 701, startSec: 1020, name: 'node' });
  f.proc(703, { ppid: 700, startSec: 1030, name: 'tunnel' });
  f.scope(AGED, [700], { 'c.slice': [701, 702, 703] });
  // a live Claude session: its scope must never be a target
  f.proc(710, { startSec: 1000, name: 'claude' });
  f.scope(LIVE, [710]);
  f.record('live', { pid: 710, procStart: 1000 * 100, unit: LIVE.replace(/\.scope$/, '') });
  // a pid that lives outside every cgroup scope
  f.proc(720, { startSec: 1000, name: 'stray' });
  return f;
}

function fakeKill(f, { exitOnTerm = [] } = {}) {
  const calls = [];
  const kill = (pid, sig) => {
    calls.push([pid, sig]);
    if (sig === 'SIGTERM' && exitOnTerm.includes(pid)) fs.rmSync(path.join(f.procRoot, String(pid)), { recursive: true });
  };
  return { calls, kill };
}

const opts = (f, kill, extra = {}) => f.deps({ kill, sleep: async () => {}, graceMs: 0, avoid: [], ...extra });

test('kill refuses a pid in a live-recorded scope', async () => {
  const f = killFixture();
  const { calls, kill } = fakeKill(f);
  const r = await killLeftovers({ unit: LIVE, pid: 710, procStart: '100000' }, opts(f, kill));
  expect(r.status).toBe(409);
  expect(calls).toEqual([]);
  fs.rmSync(f.root, { recursive: true });
});

test('kill refuses a stale procStart', async () => {
  const f = killFixture();
  const { calls, kill } = fakeKill(f);
  const r = await killLeftovers({ unit: AGED, pid: 701, procStart: '1' }, opts(f, kill));
  expect(r.status).toBe(409);
  expect(calls).toEqual([]);
  fs.rmSync(f.root, { recursive: true });
});

test('kill refuses a pid outside any leftover scope, and a unit that is not a leftover', async () => {
  const f = killFixture();
  const { calls, kill } = fakeKill(f);
  expect((await killLeftovers({ unit: AGED, pid: 720, procStart: '100000' }, opts(f, kill))).status).toBe(409);
  expect((await killLeftovers({ unit: AGED, pid: 999, procStart: '100000' }, opts(f, kill))).status).toBe(409);
  expect((await killLeftovers({ unit: 'cloudcli-claude-zzzzzzzz-1111-2222-3333-444444444444-ZZZZZZ.scope', pid: 700, procStart: '100000' }, opts(f, kill))).status).toBe(409);
  expect(calls).toEqual([]);
  fs.rmSync(f.root, { recursive: true });
});

test('kill refuses a malformed body', async () => {
  const f = killFixture();
  const { calls, kill } = fakeKill(f);
  expect((await killLeftovers(null, opts(f, kill))).status).toBe(400);
  expect((await killLeftovers({}, opts(f, kill))).status).toBe(400);
  expect((await killLeftovers({ unit: '../../etc.scope', pid: 701, procStart: '1' }, opts(f, kill))).status).toBe(400);
  expect((await killLeftovers({ unit: AGED, pid: 1, procStart: '1' }, opts(f, kill))).status).toBe(400);
  expect(calls).toEqual([]);
  fs.rmSync(f.root, { recursive: true });
});

test('kill of one pid signals it and its descendants inside the unit, SIGKILL for what survives', async () => {
  const f = killFixture();
  const { calls, kill } = fakeKill(f);
  const r = await killLeftovers({ unit: AGED, pid: 701, procStart: '101000' }, opts(f, kill));
  expect(r).toEqual({ status: 200, body: { term: [701, 702], kill: [701, 702] } });
  expect(calls).toEqual([[701, 'SIGTERM'], [702, 'SIGTERM'], [701, 'SIGKILL'], [702, 'SIGKILL']]);
  fs.rmSync(f.root, { recursive: true });
});

test('kill sends no SIGKILL to processes that exited on SIGTERM', async () => {
  const f = killFixture();
  const { calls, kill } = fakeKill(f, { exitOnTerm: [701, 702] });
  const r = await killLeftovers({ unit: AGED, pid: 701, procStart: '101000' }, opts(f, kill));
  expect(r.body).toEqual({ term: [701, 702], kill: [] });
  expect(calls.map(([, s]) => s)).toEqual(['SIGTERM', 'SIGTERM']);
  fs.rmSync(f.root, { recursive: true });
});

test('kill all signals every process of every current leftover and nothing in a live scope', async () => {
  const f = killFixture();
  const { calls, kill } = fakeKill(f, { exitOnTerm: [700, 701, 702, 703] });
  const r = await killLeftovers({ all: true }, opts(f, kill));
  // 720 lives outside every scope, so it is not a target
  expect(r.body.term.sort((a, b) => a - b)).toEqual([700, 701, 702, 703]);
  expect(calls.some(([pid]) => pid === 710)).toBe(false);
  expect(calls.filter(([, s]) => s === 'SIGKILL')).toEqual([]);
  fs.rmSync(f.root, { recursive: true });
});

test('kill never signals its own pid or its parent, even inside a leftover scope', async () => {
  const f = killFixture();
  f.proc(process.pid, { startSec: 1000, name: 'self' });
  f.proc(730, { startSec: 1000, name: 'helper' });
  f.scope(DEAD, [process.pid, 730]);
  const { calls, kill } = fakeKill(f, { exitOnTerm: [730] });
  const r = await killLeftovers({ all: true }, opts(f, kill, { avoid: [process.pid, process.ppid] }));
  expect(r.body.term).not.toContain(process.pid);
  expect(calls.some(([pid]) => pid === process.pid)).toBe(false);
  expect(calls.some(([pid]) => pid === 730)).toBe(true);
  fs.rmSync(f.root, { recursive: true });
});
