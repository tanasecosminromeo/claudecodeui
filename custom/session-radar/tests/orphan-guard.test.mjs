// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock, isRadarServerCmdline, lockPath, startOrphanGuard } from '../orphan-guard.mjs';

// A fake interval: the test fires ticks by hand.
function fakeInterval() {
  const timer = { unref: vi.fn() };
  let tick = null;
  const setIntervalFn = vi.fn((fn, ms) => { tick = fn; timer.ms = ms; return timer; });
  return { timer, setIntervalFn, fire: () => tick() };
}

describe('startOrphanGuard', () => {
  it('records the parent pid at start and does nothing while it is unchanged', () => {
    const iv = fakeInterval();
    const exit = vi.fn();
    const log = vi.fn();
    const g = startOrphanGuard({ getPpid: () => 4242, exit, log, setIntervalFn: iv.setIntervalFn });
    expect(g.startPpid).toBe(4242);
    expect(iv.timer.ms).toBe(5000);
    expect(iv.timer.unref).toHaveBeenCalled();
    iv.fire();
    iv.fire();
    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('logs one line and exits 0 once the parent pid changes', () => {
    const iv = fakeInterval();
    let ppid = 4242;
    const exit = vi.fn();
    const log = vi.fn();
    startOrphanGuard({ getPpid: () => ppid, exit, log, setIntervalFn: iv.setIntervalFn });
    ppid = 1;
    iv.fire();
    iv.fire();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('4242');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('isRadarServerCmdline', () => {
  it('accepts a node process running session-radar server.mjs', () => {
    expect(isRadarServerCmdline('/usr/bin/node\0/opt/app/plugins/session-radar/server.mjs\0')).toBe(true);
  });
  it('rejects other processes, even ones with the path in their arguments', () => {
    expect(isRadarServerCmdline('sleep\0session-radar/server.mjs\0')).toBe(false);
    expect(isRadarServerCmdline('')).toBe(false);
  });
});

describe('lockPath', () => {
  it('is keyed by uid and the parent pid', () => {
    expect(lockPath({ uid: 1000, ppid: 77, tmp: '/tmp/x' })).toBe(path.join('/tmp/x', 'session-radar-1000-77.lock'));
  });
});

describe('acquireLock', () => {
  const alive = (pids) => (p) => pids.includes(p);
  const radar = () => '/usr/bin/node\0/plugins/session-radar/server.mjs\0';
  const setup = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-lock-'));
    return { dir, file: path.join(dir, 'session-radar-1-9.lock') };
  };

  it('takes a free lock and writes our pid into it', () => {
    const { file } = setup();
    const l = acquireLock({ file, pid: 500, isAlive: alive([]), cmdlineOf: radar });
    expect(l.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('500');
  });

  it('refuses while another live radar server holds the lock', () => {
    const { file } = setup();
    fs.writeFileSync(file, '300');
    const l = acquireLock({ file, pid: 500, isAlive: alive([300]), cmdlineOf: radar });
    expect(l.ok).toBe(false);
    expect(l.holder).toBe(300);
    expect(fs.readFileSync(file, 'utf8')).toBe('300');
  });

  it('replaces a stale lock whose pid is dead', () => {
    const { file } = setup();
    fs.writeFileSync(file, '300');
    const l = acquireLock({ file, pid: 500, isAlive: alive([]), cmdlineOf: radar });
    expect(l.ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('500');
  });

  it('replaces a lock whose pid is alive but is not a radar server (pid reuse)', () => {
    const { file } = setup();
    fs.writeFileSync(file, '300');
    const l = acquireLock({ file, pid: 500, isAlive: alive([300]), cmdlineOf: () => '/usr/bin/vim\0x\0' });
    expect(l.ok).toBe(true);
  });

  it('release removes the file only while it still holds our pid', () => {
    const { file } = setup();
    const l = acquireLock({ file, pid: 500, isAlive: alive([]), cmdlineOf: radar });
    fs.writeFileSync(file, '999'); // someone else took over
    l.release();
    expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(file, '500');
    l.release();
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('server.mjs start-up gates', () => {
  const SERVER = new URL('../server.mjs', import.meta.url).pathname;
  const env = (extra = {}) => {
    const e = { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'radar-gate-')), ...extra };
    if (!('PLUGIN_NAME' in extra)) delete e.PLUGIN_NAME;
    return e;
  };

  it('refuses to serve outside CloudCLI (no PLUGIN_NAME=session-radar)', () => {
    const r = spawnSync(process.execPath, [SERVER], { env: env(), encoding: 'utf8', timeout: 10000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('start it through CloudCLI, or use --dump');
  });

  it('a second server for the same CloudCLI exits 0 while the first one holds the lock', async () => {
    const first = spawn(process.execPath, [SERVER], { env: env({ PLUGIN_NAME: 'session-radar' }), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((resolve, reject) => {
        first.stdout.once('data', resolve);
        first.once('exit', () => reject(new Error('first server exited')));
      });
      const second = spawnSync(process.execPath, [SERVER], { env: env({ PLUGIN_NAME: 'session-radar' }), encoding: 'utf8', timeout: 10000 });
      expect(second.status).toBe(0);
      expect(second.stderr).toContain('already running for this CloudCLI');
    } finally {
      first.kill();
    }
  });
});
