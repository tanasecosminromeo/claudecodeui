import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import { isProcessAlive, readProcessStartTime } from '@/shared/utils.js';

/**
 * Claude CLI processes that outlive a CloudCLI restart.
 *
 * A CLI process normally talks to the server over pipes the server owns, and
 * lives in the server's service cgroup: a restart kills it outright, and even
 * a survivor would read the closed pipes as the end of its session. Here each
 * process instead gets its own systemd scope and a pair of named pipes on
 * disk, which it holds open itself — stdin never reaches EOF and stdout never
 * breaks when the server goes away; the CLI just waits for someone to read
 * its output. A server that starts later reattaches to the same pipes from
 * the record written next to them.
 *
 * Opt-in with `CLOUDCLI_DETACHED_CLAUDE=1`. Needs `mkfifo`; the systemd scope
 * is used when `systemd-run` is available and skipped otherwise (the process
 * then only survives a restart if the service manager leaves children alone).
 */

/** What a turn of the session runs with, kept so a reattached process can be driven the same way. */
type DetachedRunOptions = {
  cwd?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  toolsSettings?: unknown;
};

/** A background task as the runtime's tracker holds it; stored so tracking survives the restart. */
type DetachedTask = Record<string, unknown> & { taskId: string };

/**
 * One detached CLI process, as recorded on disk next to its pipes.
 *
 * Used by the Claude runtime, which reattaches from it and keeps the turn,
 * task and approval fields current — they are all a restarted server has to
 * go on for what the process was doing when the old one went away.
 */
export type DetachedClaudeRecord = {
  appSessionId: string;
  providerSessionId: string | null;
  pid: number;
  /** Kernel start time of `pid`, so a recycled pid is never mistaken for the process. */
  procStart: string | null;
  dir: string;
  startedAt: string;
  options: DetachedRunOptions;
  /** A turn was in progress: its `result` has not arrived yet. */
  turnActive: boolean;
  /** The process was waiting for a tool approval, an answer the new server never saw asked. */
  awaitingPermission: boolean;
  tasks: DetachedTask[];
  /** The runtime let the process go; it is exiting and must not be reattached. */
  released?: boolean;
  /** Launched with bypass: the only way the CLI itself can be switched into it later. */
  launchedInBypass?: boolean;
};

/** The SDK's process contract (`SpawnedProcess`), plus the record the process belongs to. */
type DetachedSpawnedProcess = {
  stdin: Writable;
  stdout: Readable;
  readonly killed: boolean;
  readonly exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  on(event: string, listener: (...args: unknown[]) => void): void;
  once(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
  /** Patches the process's record on disk. */
  updateRecord(patch: Partial<DetachedClaudeRecord>): void;
};

/** The SDK's spawn options (`SpawnOptions`) — only what launching needs. */
type SpawnRequest = {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
};

/** Where the pipes and records live; overridable so tests never touch the real one. */
function processesDir(): string {
  return process.env.CLOUDCLI_CLAUDE_PROCESSES_DIR || path.join(os.homedir(), '.cloudcli', 'claude-processes');
}
const RECORD_FILE = 'record.json';

/**
 * How long the process gets to finish writing after its stdin is ended on
 * purpose. The CLI holds its own stdin open, so it never sees that EOF; the
 * end is delivered as SIGTERM instead.
 */
const RELEASE_GRACE_MS = 2000;
const EXIT_POLL_MS = 500;
const EXIT_DRAIN_MS = 250;
/** How much of a gone process's stderr is worth logging. */
const STDERR_REPORT_BYTES = 4000;

function reportStderr(record: DetachedClaudeRecord): void {
  try {
    const text = fs.readFileSync(path.join(record.dir, 'stderr.log'), 'utf8').trim();
    if (text) {
      console.warn(`[Claude detached] stderr of exited process ${record.pid} (session ${record.appSessionId}):\n${text.slice(-STDERR_REPORT_BYTES)}`);
    }
  } catch {
    // No stderr log.
  }
}

/**
 * Set once this server is exiting. From then on nothing here kills a detached
 * process: the SDK signals every process it spawned on exit, and honouring
 * that would defeat the whole point.
 */
let shuttingDown = false;
process.on('exit', () => { shuttingDown = true; });

/**
 * Whether Claude processes should be started detached. Used by the Claude
 * runtime at spawn time and by server startup to decide whether to reattach.
 */
export function isDetachedClaudeEnabled(): boolean {
  return process.env.CLOUDCLI_DETACHED_CLAUDE === '1' && process.platform !== 'win32';
}

/**
 * Stops detached processes from being killed from here on. Used by server
 * shutdown before anything else runs, so an in-flight release timer or the
 * SDK's exit handler cannot take a process down with the server.
 */
export function markDetachedClaudeShutdown(): void {
  shuttingDown = true;
}

function isRecordedProcessAlive(record: DetachedClaudeRecord): boolean {
  if (!isProcessAlive(record.pid)) {
    return false;
  }
  if (!record.procStart) {
    return true;
  }
  const current = readProcessStartTime(record.pid);
  return current === null || current === record.procStart;
}

function writeRecord(record: DetachedClaudeRecord): void {
  const target = path.join(record.dir, RECORD_FILE);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record));
  fs.renameSync(temporary, target);
}

function readRecord(dir: string): DetachedClaudeRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, RECORD_FILE), 'utf8')) as DetachedClaudeRecord;
  } catch {
    return null;
  }
}

/**
 * A folder with no record is one being set up right now (pipes made, record
 * not yet written) — unless it has been like that for a while, which means
 * the server died in between. Then only the pipes are left.
 */
const ABANDONED_DIR_AGE_MS = 60 * 1000;
function isAbandonedProcessDir(dir: string): boolean {
  try {
    return Date.now() - fs.statSync(dir).mtimeMs > ABANDONED_DIR_AGE_MS;
  } catch {
    return true;
  }
}

function removeProcessDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

let systemdRunAvailable: boolean | null = null;
function canUseSystemdScope(): boolean {
  if (systemdRunAvailable === null) {
    try {
      execFileSync('systemd-run', ['--version'], { stdio: 'ignore' });
      systemdRunAvailable = process.platform === 'linux' && process.env.CLOUDCLI_DETACHED_CLAUDE_SCOPE !== '0';
    } catch {
      systemdRunAvailable = false;
    }
  }
  return systemdRunAvailable;
}

/**
 * Wraps a detached process's pipes in the SDK's process contract. The exit is
 * noticed by polling, since the process is not this server's child.
 */
function createProcessHandle(record: DetachedClaudeRecord): DetachedSpawnedProcess {
  const events = new EventEmitter();
  let exitCode: number | null = null;
  let current = record;

  // Non-blocking and read-write, wrapped as sockets. fs streams would park a
  // worker-pool thread in a blocking read per idle process — four idle
  // sessions and every file operation in the server stalls. Read-write, so
  // opening never waits for (or fails on) the other end: at spawn the CLI has
  // not opened its ends yet. The price is that the read side never sees EOF,
  // which is why the exit is detected by polling below.
  const openPipe = (name: string) =>
    fs.openSync(path.join(record.dir, name), fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  const stdin = new net.Socket({ fd: openPipe('in'), readable: false, writable: true });
  const stdout = new net.Socket({ fd: openPipe('out'), readable: true, writable: false });
  const kill = (signal: NodeJS.Signals) => {
    if (shuttingDown || exitCode !== null) {
      return false;
    }
    try {
      process.kill(record.pid, signal);
      return true;
    } catch {
      return false;
    }
  };

  // Ending stdin is how the runtime lets a process go. The CLI never sees
  // that EOF (it holds its own stdin open), so the release is delivered as
  // SIGTERM once it has had a moment to finish writing.
  let releaseScheduled = false;
  const scheduleRelease = () => {
    if (releaseScheduled) {
      return;
    }
    releaseScheduled = true;
    setTimeout(() => { kill('SIGTERM'); }, RELEASE_GRACE_MS).unref();
  };
  stdin.once('finish', scheduleRelease);
  const originalEnd = stdin.end.bind(stdin);
  // A socket's end() also shuts the fd down, which a pipe refuses; the intent
  // — let the process go — is what matters, so it is acted on up front.
  stdin.end = ((...args: Parameters<typeof stdin.end>) => {
    scheduleRelease();
    return originalEnd(...args);
  }) as typeof stdin.end;
  stdin.on('error', () => { /* a pipe refuses shutdown(); the release above already covers it */ });

  const exitPoll = setInterval(() => {
    if (isRecordedProcessAlive(record)) {
      return;
    }
    clearInterval(exitPoll);
    // Not this server's child: its exit status is unknowable. What it wrote
    // to stderr is the only clue to a crash, so it is kept in the log.
    exitCode = 0;
    reportStderr(record);
    removeProcessDir(record.dir);
    // Nothing else ends the pipes reliably once the process is gone. The read
    // side first drains what the process wrote last.
    stdin.destroy();
    setTimeout(() => stdout.destroy(), EXIT_DRAIN_MS).unref();
    events.emit('exit', 0, null);
  }, EXIT_POLL_MS);
  exitPoll.unref();

  return {
    stdin,
    stdout,
    get killed() { return exitCode !== null; },
    get exitCode() { return exitCode; },
    kill,
    on: (event, listener) => { events.on(event, listener); },
    once: (event, listener) => { events.once(event, listener); },
    off: (event, listener) => { events.off(event, listener); },
    updateRecord(patch) {
      if (exitCode !== null) {
        return;
      }
      current = { ...current, ...patch };
      try {
        writeRecord(current);
      } catch (error) {
        console.warn('[Claude detached] Could not update the process record:', error instanceof Error ? error.message : error);
      }
    },
  };
}

/**
 * Starts a Claude CLI process detached from this server. Used as the SDK's
 * `spawnClaudeCodeProcess` by the Claude runtime when detaching is enabled.
 *
 * @param appSessionId - The app session the process serves
 * @param request - The command line and environment the SDK built
 * @param runOptions - What the session runs with, kept for a reattach
 * @param providerSessionId - The CLI's own session id, when resuming one
 */
export function spawnDetachedClaude(
  appSessionId: string,
  request: SpawnRequest,
  runOptions: DetachedRunOptions,
  providerSessionId: string | null,
): DetachedSpawnedProcess {
  fs.mkdirSync(processesDir(), { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(processesDir(), `${appSessionId.replace(/[^A-Za-z0-9_-]/g, '_')}-`));
  const inPath = path.join(dir, 'in');
  const outPath = path.join(dir, 'out');
  execFileSync('mkfifo', ['-m', '600', inPath, outPath]);
  const stderr = fs.openSync(path.join(dir, 'stderr.log'), 'a');

  // fd 3 and 4 keep both pipes open inside the CLI itself: its stdin never
  // reaches EOF and its stdout never breaks while no server is attached.
  const shellScript = 'exec 3<>"$CLOUDCLI_IN" 4<>"$CLOUDCLI_OUT"; exec "$@" <"$CLOUDCLI_IN" >"$CLOUDCLI_OUT"';
  const launch = ['sh', '-c', shellScript, 'sh', request.command, ...request.args];
  const [command, ...args] = canUseSystemdScope()
    ? [
      'systemd-run', '--user', '--scope', '--quiet', '--collect',
      `--unit=cloudcli-claude-${path.basename(dir)}`,
      // Without one, systemd describes the scope by its command line — which
      // carries the MCP config and its tokens straight into the journal.
      `--description=CloudCLI Claude session ${appSessionId}`,
      ...launch,
    ]
    : launch;

  const child = spawn(command, args, {
    cwd: request.cwd,
    env: { ...request.env, CLOUDCLI_IN: inPath, CLOUDCLI_OUT: outPath },
    detached: true,
    stdio: ['ignore', 'ignore', stderr],
  });
  // A launch failure (the project folder is gone, say) arrives as an 'error'
  // event a tick later; unhandled, it would take the whole server down.
  child.on('error', (error) => {
    console.error(`[Claude detached] Could not start the Claude process for session ${appSessionId}:`, error.message);
  });
  child.unref();
  fs.closeSync(stderr);
  if (!child.pid) {
    removeProcessDir(dir);
    throw new Error(`Could not start the Claude process (working directory ${request.cwd ?? 'unset'})`);
  }

  const record: DetachedClaudeRecord = {
    appSessionId,
    providerSessionId,
    pid: child.pid,
    procStart: readProcessStartTime(child.pid),
    dir,
    startedAt: new Date().toISOString(),
    options: runOptions,
    turnActive: true,
    awaitingPermission: false,
    tasks: [],
  };
  writeRecord(record);
  return createProcessHandle(record);
}

/** How long a process asked to stop gets before it is killed. */
const STOP_GRACE_MS = 5000;

/**
 * Ends a detached process no server will drive again — one that was released
 * as the previous server went away (its SIGTERM never came), or a duplicate —
 * and removes its record. Used by the Claude runtime's reattach.
 */
export async function stopDetachedClaude(record: DetachedClaudeRecord): Promise<void> {
  try { process.kill(record.pid, 'SIGTERM'); } catch { /* already gone */ }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (isRecordedProcessAlive(record) && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  if (isRecordedProcessAlive(record)) {
    try { process.kill(record.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  reportStderr(record);
  removeProcessDir(record.dir);
}

/**
 * Connects to a detached process a previous server started. Used as the
 * SDK's `spawnClaudeCodeProcess` when the Claude runtime reattaches.
 */
export function attachDetachedClaude(record: DetachedClaudeRecord): DetachedSpawnedProcess {
  return createProcessHandle(record);
}

/**
 * Every detached process still running, oldest first. Records of processes
 * that are gone are cleaned up on the way. Used by the Claude runtime to
 * reattach at startup, and by the duplicate-session check to know which live
 * CLI processes are CloudCLI's own.
 */
export function listDetachedClaudeRecords(): DetachedClaudeRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(processesDir());
  } catch {
    return [];
  }

  const live: DetachedClaudeRecord[] = [];
  for (const entry of entries) {
    const dir = path.join(processesDir(), entry);
    const record = readRecord(dir);
    if (record && isRecordedProcessAlive(record)) {
      live.push(record);
    } else if (record || isAbandonedProcessDir(dir)) {
      removeProcessDir(dir);
    }
  }
  return live.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}
