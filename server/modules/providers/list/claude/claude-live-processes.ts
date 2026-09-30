import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isProcessAlive, readProcessStartTime } from '@/shared/utils.js';

/**
 * Other Claude Code processes that have a session open.
 *
 * Every Claude Code process — a terminal `claude`, an IDE extension, an SDK
 * process like CloudCLI's own — registers itself in
 * `~/.claude/sessions/<pid>.json` with the session it is on. Two processes on
 * one session both append to its transcript and fork the conversation, each
 * unaware of the other, so this is what CloudCLI checks before it starts one.
 */

/** A live Claude Code process on a session, as its registry file describes it. */
export type LiveClaudeProcess = {
  pid: number;
  sessionId: string;
  /** How it was started: `cli` for a terminal, `sdk-ts` for an SDK host like CloudCLI, `claude-vscode`, … */
  entrypoint: string | null;
  cwd: string | null;
  startedAt: number | null;
};

type RegistryEntry = {
  pid?: unknown;
  sessionId?: unknown;
  procStart?: unknown;
  entrypoint?: unknown;
  cwd?: unknown;
  startedAt?: unknown;
};

function sessionsRegistryDir(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(configDir, 'sessions');
}

/**
 * The live Claude Code processes on a provider session, other than the pids
 * given. Registry files outlive crashed processes, so a pid only counts when
 * it is alive and — where the kernel can tell — still the process that wrote
 * the file.
 *
 * Used by the Claude runtime before it starts a process on a session, and by
 * the shell tab before it resumes one.
 *
 * @param providerSessionId - The CLI's own session id (the transcript file name)
 * @param ownPids - Processes to leave out: CloudCLI's own
 */
export function findOtherLiveClaudeProcesses(
  providerSessionId: string,
  ownPids: ReadonlySet<number> = new Set(),
): LiveClaudeProcess[] {
  let files: string[];
  try {
    files = fs.readdirSync(sessionsRegistryDir()).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }

  const found: LiveClaudeProcess[] = [];
  for (const file of files) {
    let entry: RegistryEntry;
    try {
      entry = JSON.parse(fs.readFileSync(path.join(sessionsRegistryDir(), file), 'utf8')) as RegistryEntry;
    } catch {
      continue;
    }
    if (entry.sessionId !== providerSessionId || typeof entry.pid !== 'number' || ownPids.has(entry.pid)) {
      continue;
    }
    if (!isProcessAlive(entry.pid)) {
      continue;
    }
    const startTime = readProcessStartTime(entry.pid);
    if (startTime !== null && typeof entry.procStart === 'string' && startTime !== entry.procStart) {
      continue;
    }
    found.push({
      pid: entry.pid,
      sessionId: providerSessionId,
      entrypoint: typeof entry.entrypoint === 'string' ? entry.entrypoint : null,
      cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
      startedAt: typeof entry.startedAt === 'number' ? entry.startedAt : null,
    });
  }
  return found;
}

/** How long a process asked to stop gets before it is killed. */
const STOP_GRACE_MS = 5000;

/**
 * Stops other processes so this one can take the session over: SIGTERM, then
 * SIGKILL for whatever is still up after the grace period. Resolves once they
 * are all gone. Used by the Claude runtime when the user chose to take a
 * session over from a terminal.
 */
export async function stopClaudeProcesses(processes: LiveClaudeProcess[]): Promise<void> {
  for (const { pid } of processes) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (processes.some(({ pid }) => isProcessAlive(pid)) && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  for (const { pid } of processes) {
    if (isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}
