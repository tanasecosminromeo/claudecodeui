// @vitest-environment node
import { expect, it as test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HISTORY_MAX, historyOf, processFor } from '../process-detail.mjs';

// A fake /proc, cgroup tree and records dir: nothing real is read or signalled.
// Start times are written in clock ticks (100 per second after boot), as /proc/<pid>/stat has them.
const BOOT_S = 1_700_000_000;
const NOW = (BOOT_S + 100_000) * 1000;
const UID = process.getuid();
const SESSION_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
const SESSION = `cloudcli-claude-${SESSION_ID}-BBBBBB.scope`;
const LEFTOVER = 'cloudcli-claude-aaaaaaaa-1111-2222-3333-444444444444-AAAAAA.scope';
const FAKE_KEY = `sk-${'a1B2c3D4e5F6g7H8i9J0k1L2'}`; // built at run time, never written as a literal

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-process-'));
  const f = {
    root,
    procRoot: path.join(root, 'proc'),
    cgroupRoot: path.join(root, 'app.slice'),
    recordsDir: path.join(root, 'claude-processes'),
    target: path.join(root, 'workdir'),
  };
  for (const d of [f.procRoot, f.cgroupRoot, f.recordsDir, f.target]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(f.procRoot, 'stat'), `cpu 1 2 3\nbtime ${BOOT_S}\n`);
  // startSec: seconds after boot. The process's procStart is then String(startSec * 100).
  f.proc = (pid, { ppid = 1, startSec = 1000, name = 'worker', argv = [name], rssKb = 2048, unit = 'session.scope',
    utime = 0, stime = 0, threads = 1, state = 'S', cwd = null } = {}) => {
    const dir = path.join(f.procRoot, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    const rest = [state, String(ppid), ...Array(9).fill('0'), String(utime), String(stime), ...Array(6).fill('0'), String(startSec * 100)].join(' ');
    fs.writeFileSync(path.join(dir, 'stat'), `${pid} (${name}) ${rest}\n`);
    fs.writeFileSync(path.join(dir, 'cmdline'), `${argv.join('\0')}\0`);
    fs.writeFileSync(path.join(dir, 'status'), `Name:\t${name}\nThreads:\t${threads}\nVmRSS:\t${rssKb} kB\n`);
    fs.writeFileSync(path.join(dir, 'cgroup'), `0::/user.slice/app.slice/${unit}\n`);
    if (cwd) fs.symlinkSync(cwd, path.join(dir, 'cwd'));
  };
  f.kids = (pid, kids) => {
    const dir = path.join(f.procRoot, String(pid), 'task', String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'children'), `${kids.join(' ')}\n`);
  };
  f.scope = (unit, pids) => {
    const dir = path.join(f.cgroupRoot, unit);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cgroup.procs'), pids.map((p) => `${p}\n`).join(''));
  };
  f.record = (name, { pid, procStart, unit }) => {
    const dir = path.join(f.recordsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify({ pid, procStart: String(procStart), unit: unit.replace(/\.scope$/, '') }));
  };
  return f;
}

// A session: claude 500 (live record) -> bash 501 -> sleep 502.
function sessionTree() {
  const f = fixture();
  f.proc(500, {
    name: 'claude', argv: ['/opt/bin/claude', '--model', 'claude-sonnet-5-5', '--token', FAKE_KEY], startSec: 1000,
    unit: SESSION, rssKb: 4096, utime: 6000, stime: 2000, threads: 9, cwd: f.target,
  });
  f.kids(500, [501]);
  f.proc(501, { ppid: 500, name: 'bash', argv: ['bash', '-c', `npm run dev --api-key=${FAKE_KEY}`], startSec: 1100, unit: SESSION });
  f.kids(501, [502]);
  f.proc(502, { ppid: 501, name: 'sleep', argv: ['sleep', '600'], startSec: 1200, unit: SESSION });
  f.scope(SESSION, [500, 501, 502]);
  f.record(SESSION_ID, { pid: 500, procStart: 100000, unit: SESSION });
  return f;
}

const deps = (f, extra = {}) => ({ procRoot: f.procRoot, cgroupRoot: f.cgroupRoot, recordsDir: f.recordsDir, now: NOW, uid: UID, ...extra });

test('describes a live session process: fields, masked command, cwd, cpu, state, threads, children', () => {
  const f = sessionTree();
  const r = processFor({ pid: 500, procStart: '100000' }, deps(f));
  expect(r.status).toBe(200);
  const b = r.body;
  expect(b.name).toBe('claude');
  expect(b.pid).toBe(500);
  expect(b.ppid).toBe(1);
  expect(b.command).toContain('--model claude-sonnet-5-5');
  expect(b.command).not.toContain(FAKE_KEY);
  expect(b.command).toContain('•••');
  expect(b.cwd).toBe(f.target);
  expect(b.startedAt).toBe((BOOT_S + 1000) * 1000);
  expect(b.ageMs).toBe(NOW - (BOOT_S + 1000) * 1000);
  expect(b.state).toBe('S');
  expect(b.threads).toBe(9);
  expect(b.rssBytes).toBe(4096 * 1024);
  expect(b.cpu.seconds).toBe(80);
  expect(b.cpu.percent).toBe(0.1); // 80 s of CPU over a 99000 s life
  expect(b.scope).toEqual({ unit: SESSION, kind: 'session', appSessionId: SESSION_ID });
  expect(b.killable).toBe(false);
  expect(b.children).toEqual([{ pid: 501, procStart: '110000', name: 'bash', command: expect.stringContaining('--api-key=•••') }]);
  expect(b.children[0].command).not.toContain(FAKE_KEY);
  expect(b.historyAvailable).toBe(false);
  expect(b.history).toEqual([]);
});

test('returns 404 for a gone pid and for a stale procStart (reused pid)', () => {
  const f = sessionTree();
  expect(processFor({ pid: 999, procStart: '100000' }, deps(f)).status).toBe(404);
  expect(processFor({ pid: 500, procStart: '123400' }, deps(f)).status).toBe(404);
});

test('returns 400 for malformed parameters', () => {
  const f = sessionTree();
  expect(processFor({ pid: 0, procStart: '100000' }, deps(f)).status).toBe(400);
  expect(processFor({ pid: NaN, procStart: '100000' }, deps(f)).status).toBe(400);
  expect(processFor({ pid: 500, procStart: '' }, deps(f)).status).toBe(400);
  expect(processFor({ pid: 500, procStart: 'abc' }, deps(f)).status).toBe(400);
});

test('returns 403 for a process owned by another uid', () => {
  const f = sessionTree();
  // The fixture's files belong to the test user; a caller with another uid is refused.
  expect(processFor({ pid: 500, procStart: '100000' }, deps(f, { uid: UID + 1 })).status).toBe(403);
});

test('classifies scopes: live session, leftover (killable), the CloudCLI service, other', () => {
  const f = fixture();
  // A leftover: no live record for its unit, and its oldest process is well past the age guard.
  f.proc(600, { name: 'tunnel', argv: ['cloudflared', 'tunnel', 'run'], startSec: 1000, unit: LEFTOVER });
  f.proc(601, { ppid: 600, name: 'node', argv: ['node', 'server.js'], startSec: 1100, unit: LEFTOVER });
  f.kids(600, [601]);
  f.scope(LEFTOVER, [600, 601]);
  f.proc(610, { name: 'cloudcli', startSec: 1000, unit: 'cloudcli.service' });
  f.proc(620, { name: 'app', startSec: 1000, unit: 'app-misc.scope' });

  const leftover = processFor({ pid: 600, procStart: '100000' }, deps(f)).body;
  expect(leftover.scope.kind).toBe('leftover');
  expect(leftover.killable).toBe(true);
  expect(leftover.scope.unit).toBe(LEFTOVER);
  expect(leftover.children.map((c) => c.pid)).toEqual([601]);

  expect(processFor({ pid: 610, procStart: '100000' }, deps(f)).body.scope.kind).toBe('service');
  expect(processFor({ pid: 620, procStart: '100000' }, deps(f)).body.scope.kind).toBe('other');
});

test('a process in a cloudcli scope too young to be a leftover is not killable', () => {
  const f = fixture();
  const young = 'cloudcli-claude-cccccccc-1111-2222-3333-444444444444-CCCCCC.scope';
  f.proc(630, { name: 'fresh', startSec: 99_990, unit: young });
  f.scope(young, [630]);
  const body = processFor({ pid: 630, procStart: '9999000' }, deps(f)).body;
  expect(body.scope.kind).toBe('scope');
  expect(body.killable).toBe(false);
});

test('a live record for the unit makes it a session, even when the pid is listed in its cgroup', () => {
  const f = sessionTree();
  f.proc(640, { name: 'stray', startSec: 1000, unit: SESSION });
  f.scope(SESSION, [500, 501, 502, 640]);
  expect(processFor({ pid: 640, procStart: '100000' }, deps(f)).body.scope.kind).toBe('session');
});

test('history: the subtree\'s execs newest first with their exits; an earlier run of the same pid is dropped', () => {
  const f = sessionTree();
  const T = (BOOT_S + 1000) * 1000; // the claude process started at 1000 s after boot
  const recs = [
    { ts: T - 50_000, ev: 'exec', pid: 500, ppid: 1, root: 500, argv: 'old claude run' },
    { ts: T + 500, ev: 'exec', pid: 500, ppid: 1, root: 500, argv: '/opt/bin/claude --model claude-sonnet-5-5' },
    { ts: T + 1000, ev: 'exec', pid: 501, ppid: 500, root: 500, argv: 'bash -c npm run dev' },
    { ts: T + 2000, ev: 'exec', pid: 502, ppid: 501, root: 500, argv: 'curl https://example.com/?token=abc123' },
    { ts: T + 2500, ev: 'exit', pid: 502, code: 2 },
    { ts: T + 3000, ev: 'exec', pid: 900, ppid: 1, root: 900, argv: 'unrelated' },
  ];
  const r = processFor({ pid: 500, procStart: '100000' }, deps(f, { execLog: { records: () => recs } }));
  expect(r.body.historyAvailable).toBe(true);
  expect(r.body.history.map((h) => h.pid)).toEqual([502, 501, 500]);
  expect(r.body.history[0].status).toBe('exit 2');
  expect(r.body.history[0].cmd).not.toContain('abc123');
  expect(r.body.history[1].status).toBe('no exit recorded');
  expect(r.body.historyTotal).toBe(3);
});

test('history is capped at 50, newest first', () => {
  const f = sessionTree();
  const T = (BOOT_S + 1000) * 1000;
  const recs = Array.from({ length: 60 }, (_, i) => ({ ts: T + 1000 + i, ev: 'exec', pid: 500, ppid: 1, root: 500, argv: `cmd ${i}` }));
  const r = processFor({ pid: 500, procStart: '100000' }, deps(f, { execLog: { records: () => recs } }));
  expect(r.body.history.length).toBe(HISTORY_MAX);
  expect(r.body.history[0].cmd).toBe('cmd 59');
  expect(r.body.historyTotal).toBe(60);
});

test('historyOf reports a signal exit, and an exec with no exit as still open', () => {
  const out = historyOf([
    { ts: 5000, ev: 'exec', pid: 3, ppid: 1, argv: 'sleep 9' },
    { ts: 6000, ev: 'exit', pid: 3, code: 0, sig: 9 },
    { ts: 7000, ev: 'exec', pid: 4, ppid: 3, argv: 'tail -f x' },
  ], [3, 4], 4000);
  expect(out[0].status).toBe('no exit recorded');
  expect(out[1].status).toBe('killed by signal 9');
  expect(out[1].endMs).toBe(6000);
});

test('against the real /proc: this test process is described, and a wrong procStart is refused', async () => {
  const { procStartOf } = await import('../detail.mjs');
  const start = procStartOf(process.pid);
  const ok = processFor({ pid: process.pid, procStart: start }, {});
  expect(ok.status).toBe(200);
  expect(ok.body.pid).toBe(process.pid);
  expect(ok.body.procStart).toBe(start);
  expect(processFor({ pid: process.pid, procStart: '1' }, {}).status).toBe(404);
});
