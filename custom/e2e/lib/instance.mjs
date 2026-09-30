// The CloudCLI instance under test: a second, fully isolated copy of the app,
// run as its own transient systemd user service so a "restart" in a scenario is
// a real `systemctl --user restart`, exactly what `make restart` does to the
// live service.
//
// Isolation from the live instance (port 3001, ~/.cloudcli/auth.db):
//   - its own port (E2E_PORT, default 3101), loopback only
//   - its own database, project folder and detached-process folder, all under
//     one run directory (E2E_RUN_DIR, default ~/.cache/cloudcli-e2e — not /tmp:
//     the app refuses to create projects in system directories)
// Shared on purpose: ~/.claude (the real Claude Code login and settings — the
// scenarios run the real CLI).
// Shared because they cannot be separated without a fake HOME (which would
// also cut the instance off from the Claude login): ~/.claude-code-ui plugins
// — the instance starts its own copies of the enabled plugin servers on
// random ports — and the read-only index of ~/.claude/projects, so its
// sidebar lists your real projects. Scenarios only ever open `e2e-project`.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const UNIT = process.env.E2E_UNIT || 'cloudcli-e2e';

/** Where everything a run creates lives; removed by `cleanup()`. */
export function runPaths(runDir) {
  return {
    runDir,
    database: path.join(runDir, 'auth.db'),
    project: path.join(runDir, 'project'),
    processes: path.join(runDir, 'claude-processes'),
    artifacts: path.join(runDir, 'artifacts'),
  };
}

function systemctl(...args) {
  return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function isActive() {
  try {
    return systemctl('is-active', UNIT).trim() === 'active';
  } catch {
    return false;
  }
}

/** Reads a value from the app's .env without loading the rest of it. */
function readDotEnv(appDir, key) {
  try {
    const line = fs.readFileSync(path.join(appDir, '.env'), 'utf8')
      .split('\n').find((candidate) => candidate.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Starts the instance from `appDir` (which must already be built: dist/ and
 * dist-server/). Resolves once the HTTP server answers.
 */
export async function startInstance({ appDir, sourceDir, port, paths, log }) {
  if (isActive()) {
    log(`stopping a leftover ${UNIT} unit`);
    stopInstance();
  }
  fs.mkdirSync(paths.project, { recursive: true });
  fs.mkdirSync(paths.processes, { recursive: true });
  fs.mkdirSync(paths.artifacts, { recursive: true });

  // The live service passes an absolute CLI path; newer SDKs reject a bare
  // `claude`. Take it from the environment, else from the app's .env, else
  // from the checkout the app was mirrored from (its .env is not mirrored).
  const claudeCliPath = process.env.CLAUDE_CLI_PATH
    || readDotEnv(appDir, 'CLAUDE_CLI_PATH')
    || (sourceDir ? readDotEnv(sourceDir, 'CLAUDE_CLI_PATH') : undefined);

  const env = {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    SERVER_PORT: String(port),
    DATABASE_PATH: paths.database,
    CLOUDCLI_DETACHED_CLAUDE: process.env.E2E_DETACHED ?? '1',
    CLOUDCLI_CLAUDE_PROCESSES_DIR: paths.processes,
    // A short hold for background work the runtime cannot track (30 min in
    // production). Tracked work — every backgrounded command the scenarios
    // start — must outlive this: that is what `16-restart-idle-with-background`
    // checks, and what killed a real crash watch before the two were told apart.
    CLOUDCLI_BG_WAIT_CEILING_MS: process.env.E2E_BG_WAIT_CEILING_MS ?? '20000',
    PATH: process.env.PATH,
    ...(claudeCliPath ? { CLAUDE_CLI_PATH: claudeCliPath } : {}),
  };

  execFileSync('systemd-run', [
    '--user', `--unit=${UNIT}`, '--collect', '--quiet',
    `--working-directory=${appDir}`,
    '--property=KillMode=control-group',
    // A scenario must never wait out systemd's default 90s for a child that
    // ignores SIGTERM; the app now ends its own terminals on shutdown anyway.
    '--property=TimeoutStopSec=15',
    ...Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`),
    process.execPath, 'dist-server/server/index.js',
  ]);
  log(`started ${UNIT} from ${appDir} on 127.0.0.1:${port}`);
  await waitForHttp(port, log);
}

/**
 * Restarts the instance the way `make restart` restarts the live one, and
 * resolves once it answers again.
 */
export async function restartInstance({ port, log }) {
  log(`systemctl --user restart ${UNIT}`);
  systemctl('restart', UNIT);
  await waitForHttp(port, log);
}

/**
 * Kills the instance outright (SIGKILL: no shutdown handlers run — a crash,
 * an OOM kill) and starts it again, resolving once it answers.
 */
export async function crashInstance({ appDir, sourceDir, port, paths, log }) {
  log(`systemctl --user kill --signal=SIGKILL ${UNIT}`);
  systemctl('kill', '--signal=SIGKILL', UNIT);
  for (let i = 0; i < 50 && isActive(); i++) {
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  await startInstance({ appDir, sourceDir, port, paths, log });
}

export function stopInstance() {
  try {
    systemctl('stop', UNIT);
  } catch {
    // Not running.
  }
}

async function waitForHttp(port, log, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`);
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => { setTimeout(resolve, 500); });
  }
  log(serverLog(200));
  throw new Error(`${UNIT} did not answer on port ${port} within ${timeoutMs / 1000}s`);
}

/** The last `lines` of the instance's own log (stdout/stderr of the unit). */
export function serverLog(lines = 400) {
  try {
    return execFileSync('journalctl', ['--user', '-u', UNIT, '-n', String(lines), '-o', 'short-iso', '--no-pager'], { encoding: 'utf8' });
  } catch (error) {
    return `(journal unavailable: ${error.message})`;
  }
}

/**
 * Creates the test user and a project for the run folder, returning the auth
 * token the browser uses and the project as the API describes it.
 */
export async function bootstrapApp({ port, paths }) {
  const base = `http://127.0.0.1:${port}`;
  const credentials = { username: 'e2e', password: 'e2e-password-1234' };
  let response = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
  });
  if (!response.ok) {
    // Already registered (a restarted instance keeps its database).
    response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials),
    });
  }
  const auth = await response.json();
  if (!auth.token) {
    throw new Error(`could not log in: ${JSON.stringify(auth)}`);
  }

  // Skip the first-run wizard: its git step writes `git config --global`.
  await fetch(`${base}/api/user/complete-onboarding`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth.token}` },
  });

  const projectResponse = await fetch(`${base}/api/projects/create-project`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify({ path: paths.project, customName: 'e2e-project' }),
  });
  const project = await projectResponse.json();
  if (project.success) {
    return { token: auth.token, project: project.project, base };
  }
  // The sessions watcher may already have indexed the folder from transcripts
  // a previous run left behind; the project is then simply there.
  if (project.error?.code === 'PROJECT_ALREADY_EXISTS') {
    const list = await (await fetch(`${base}/api/projects`, { headers: { Authorization: `Bearer ${auth.token}` } })).json();
    const projects = Array.isArray(list) ? list : list.projects ?? list.data ?? [];
    const existing = projects.find((candidate) => candidate.fullPath === paths.project || candidate.path === paths.project);
    if (existing) {
      return { token: auth.token, project: existing, base };
    }
  }
  throw new Error(`could not create the project: ${JSON.stringify(project)}`);
}

/**
 * Detached Claude processes this instance started, read from its own
 * processes folder (never the live instance's): pid, session and state.
 */
export function detachedProcesses(paths) {
  let entries = [];
  try {
    entries = fs.readdirSync(paths.processes);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(paths.processes, entry, 'record.json'), 'utf8'));
      try {
        process.kill(record.pid, 0);
      } catch {
        return [];
      }
      return [record];
    } catch {
      return [];
    }
  });
}

/** Where Claude Code keeps the transcripts of sessions run in the test project. */
export function transcriptsDir(paths) {
  return path.join(process.env.HOME, '.claude', 'projects', paths.project.replace(/[^A-Za-z0-9]/g, '-'));
}

/** Starts from nothing: no run folder, no transcripts from an earlier run. */
export function resetRun(paths) {
  fs.rmSync(paths.runDir, { recursive: true, force: true });
  fs.rmSync(transcriptsDir(paths), { recursive: true, force: true });
}

/**
 * Removes everything the run created: the instance, its detached Claude
 * processes, the run folder and the transcripts its sessions wrote to
 * ~/.claude/projects (named after the run's project folder).
 */
export function cleanup({ paths, keep, log }) {
  stopInstance();
  for (const record of detachedProcesses(paths)) {
    try {
      process.kill(record.pid, 'SIGKILL');
      log(`killed leftover Claude process ${record.pid}`);
    } catch {
      // Already gone.
    }
  }
  // The transcripts the scenarios' sessions wrote: kept with the artifacts
  // when the run folder is kept (what Claude did on disk is often the answer),
  // never left behind in ~/.claude.
  if (keep && fs.existsSync(transcriptsDir(paths))) {
    fs.cpSync(transcriptsDir(paths), path.join(paths.artifacts, 'transcripts'), { recursive: true });
  }
  fs.rmSync(transcriptsDir(paths), { recursive: true, force: true });
  if (!keep) {
    // The artifacts (report, screenshots) stay; the rest goes.
    for (const dir of [paths.database, paths.project, paths.processes]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
