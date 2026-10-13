// Process guards for session-radar's server: exit when CloudCLI (the parent) is gone, and allow only
// one radar server per CloudCLI instance. Every OS touch is injectable so the tests need no real process.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CHECK_MS = 5000;

/**
 * Records the parent pid now; every intervalMs, if the parent pid has changed (the parent died and
 * this process was re-parented), logs one line and exits 0. The timer is unref'd.
 */
export function startOrphanGuard({
  getPpid = () => process.ppid,
  exit = (code) => process.exit(code),
  setIntervalFn = setInterval,
  log = (msg) => console.error(msg),
  intervalMs = CHECK_MS,
} = {}) {
  const startPpid = getPpid();
  let fired = false;
  const timer = setIntervalFn(() => {
    const now = getPpid();
    if (fired || now === startPpid) return;
    fired = true;
    log(`session-radar: parent ${startPpid} is gone (now ${now}), exiting`);
    exit(0);
  }, intervalMs);
  timer?.unref?.();
  return { startPpid, timer };
}

/** Lock file for one CloudCLI instance: keyed by uid and by the parent (CloudCLI) pid. */
export function lockPath({ uid = process.getuid(), ppid = process.ppid, tmp = os.tmpdir() } = {}) {
  return path.join(tmp, `session-radar-${uid}-${ppid}.lock`);
}

/** A live process by /proc entry (no signal is sent). */
export function procAlive(pid, procRoot = '/proc') {
  return fs.existsSync(path.join(procRoot, String(pid)));
}

/** True when the cmdline (NUL-separated, as in /proc) is a node process running session-radar's server. */
export function isRadarServerCmdline(cmdline) {
  const parts = String(cmdline || '').split('\0').filter(Boolean);
  return parts.length > 0 && /node/.test(path.basename(parts[0])) && parts.join(' ').includes('session-radar/server.mjs');
}

function readCmdline(pid, procRoot = '/proc') {
  try { return fs.readFileSync(path.join(procRoot, String(pid), 'cmdline'), 'utf8'); } catch { return ''; }
}

/**
 * Takes the lock by creating `file` exclusively (flag 'wx') with our pid inside. If it exists and
 * its pid is alive and is a radar server, returns { ok: false, holder }. A stale lock (dead pid, or a
 * pid that is some other program) is replaced. release() removes the file only while it still holds our pid.
 */
export function acquireLock({
  file,
  pid = process.pid,
  fsx = fs,
  isAlive = (p) => procAlive(p),
  cmdlineOf = (p) => readCmdline(p),
}) {
  const release = () => {
    try { if (fsx.readFileSync(file, 'utf8').trim() === String(pid)) fsx.unlinkSync(file); } catch { /* already gone */ }
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fsx.writeFileSync(file, String(pid), { flag: 'wx' });
      return { ok: true, holder: null, release };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let holder = NaN;
    try { holder = Number(fsx.readFileSync(file, 'utf8').trim()); } catch { continue; } // removed meanwhile: retry
    if (Number.isInteger(holder) && holder > 0 && holder !== pid && isAlive(holder) && isRadarServerCmdline(cmdlineOf(holder))) {
      return { ok: false, holder, release };
    }
    try { fsx.unlinkSync(file); } catch { /* another starter removed it first */ }
  }
  return { ok: false, holder: null, release };
}
