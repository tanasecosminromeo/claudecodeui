#!/usr/bin/env node
// End-to-end tests for CloudCLI: a real, isolated instance of the app, real
// Claude CLI processes, a real browser. See custom/e2e/README.md.
//
//   node custom/e2e/run.mjs                 build + run every scenario
//   node custom/e2e/run.mjs --only=restart  scenarios whose name contains "restart"
//   node custom/e2e/run.mjs --list          list scenarios
//
// Options:
//   --only=a,b        run scenarios whose file name contains any of the words
//   --app-dir=DIR     test an already-built app folder as is (no mirroring, no build)
//   --skip-build      reuse the e2e worktree's last build
//   --keep            keep the run folder (database, artifacts) after the run
//   --headed          show the browser
//   --port=N          port for the test instance (default 3101)
//   --with-unit       also run the unit tests behind the same guarantees, into the report
//
// Every run writes a self-contained HTML report (steps, timing, screenshots)
// to <run dir>/artifacts/report.html and copies it to custom/e2e/reports/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChatPage, loadPlaywright } from './lib/chat.mjs';
import {
  bootstrapApp,
  cleanup,
  crashInstance,
  detachedProcesses,
  resetRun,
  restartInstance,
  runPaths,
  serverLog,
  startInstance,
} from './lib/instance.mjs';
import { prepareWorkspace } from './lib/workspace.mjs';
import { runUnitTests, UNIT_TEST_FILES, writeReport } from './lib/report.mjs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(here, '../..');

/** One value from a .env file, without loading the rest of it. */
function readDotEnv(file, key) {
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n').find((candidate) => candidate.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The scenario's leading comment block: what it proves, for the report. */
function readScenarioDescription(file) {
  const lines = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('//')) {
      lines.push(line.replace(/^\/\/ ?/, ''));
    } else if (lines.length > 0 && line.trim() !== '') {
      break;
    } else if (line.startsWith('import') || line.trim() === '') {
      continue;
    } else {
      break;
    }
  }
  return lines.join('\n').trim();
}

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, value] = arg.replace(/^--/, '').split('=');
  return [key, value ?? true];
}));

const log = (...parts) => console.log(`[e2e ${new Date().toISOString().slice(11, 19)}]`, ...parts);

const scenarioDir = path.join(here, 'scenarios');
const allScenarios = fs.readdirSync(scenarioDir).filter((file) => file.endsWith('.mjs')).sort();
const wanted = typeof args.only === 'string' ? args.only.split(',') : null;
const selected = wanted ? allScenarios.filter((file) => wanted.some((word) => file.includes(word))) : allScenarios;

if (args.list) {
  for (const file of allScenarios) {
    const { meta } = await import(path.join(scenarioDir, file));
    console.log(`${file.padEnd(34)} ${meta.title}`);
  }
  process.exit(0);
}

const port = Number(args.port ?? process.env.E2E_PORT ?? 3101);
const paths = runPaths(process.env.E2E_RUN_DIR || path.join(process.env.HOME, '.cache', 'cloudcli-e2e'));
const worktreeDir = process.env.E2E_WORKTREE || path.join(path.dirname(repoDir), 'claudecodeui-worktrees', 'e2e');

let appDir;
if (typeof args['app-dir'] === 'string') {
  appDir = path.resolve(args['app-dir']);
} else if (args['skip-build']) {
  appDir = worktreeDir;
} else {
  appDir = prepareWorkspace({ sourceDir: repoDir, worktreeDir, log });
  // The live service applies the ui-cleanup layer before every start
  // (custom/ui-cleanup/inject.sh in ExecStartPre), so the app under test
  // does too. Only the HTML step: inject.sh's plugin sync writes to the
  // shared ~/.claude-code-ui/plugins the live service reads.
  execFileSync('node', [path.join(repoDir, 'custom', 'ui-cleanup', 'inject-html.mjs'), appDir], { stdio: 'inherit' });
}

resetRun(paths);
fs.mkdirSync(paths.artifacts, { recursive: true });
const startedAt = new Date().toISOString();
const results = [];
const gitInfo = (() => {
  try {
    return {
      commit: execFileSync('git', ['-C', repoDir, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    };
  } catch {
    return { commit: 'unknown', dirty: false };
  }
})();
let browser;

try {
  await startInstance({ appDir, sourceDir: repoDir, port, paths, log });
  const app = await bootstrapApp({ port, paths });
  log(`instance ready: ${app.base}, project ${app.project.fullPath}`);

  const { chromium } = loadPlaywright();
  browser = await chromium.launch({ headless: !args.headed });

  for (const file of selected) {
    const { meta, run } = await import(path.join(scenarioDir, file));
    const name = file.replace(/\.mjs$/, '');
    const artifacts = path.join(paths.artifacts, name);
    log(`▶ ${name}: ${meta.title}`);

    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.addInitScript(({ token, model, mode }) => {
      // Once per page load, before the app reads them.
      if (!sessionStorage.getItem('e2e-seeded')) {
        localStorage.setItem('auth-token', token);
        localStorage.setItem('claude-model', model);
        localStorage.setItem('permissionMode-last-claude', mode);
        sessionStorage.setItem('e2e-seeded', '1');
      }
    }, { token: app.token, model: meta.model ?? 'haiku', mode: meta.mode ?? 'bypassPermissions' });
    const page = await context.newPage();
    const chat = new ChatPage(page, { base: app.base, projectName: 'e2e-project' });

    const started = Date.now();
    // What the report shows for this scenario: every check, note and picture.
    const steps = [];
    const images = [];
    fs.mkdirSync(artifacts, { recursive: true });
    const scenarioLog = (...parts) => {
      log(`  ${name}:`, ...parts);
      steps.push({ kind: 'note', text: parts.join(' ') });
    };
    const expect = (condition, message) => {
      steps.push({ kind: 'check', ok: Boolean(condition), text: message });
      if (!condition) {
        throw new Error(`expectation failed: ${message}`);
      }
      log(`  ${name}: ✓ ${message}`);
    };
    const snapshot = async (label) => {
      const file = path.join(artifacts, `${images.length + 1}-${label.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 70 }).catch(() => {});
      images.push({ label, file });
      steps.push({ kind: 'note', text: `screenshot: ${label}` });
    };
    const tools = {
      chat,
      page,
      app,
      paths,
      log: scenarioLog,
      expect,
      sleep: (ms) => page.waitForTimeout(ms),
      snapshot,
      restart: () => restartInstance({ port, log: scenarioLog }),
      crash: () => crashInstance({ appDir, sourceDir: repoDir, port, paths, log: scenarioLog }),
      processes: (sessionId) => detachedProcesses(paths).filter((record) => !sessionId || record.appSessionId === sessionId),
      projectFile: (name) => path.join(paths.project, name),
    };

    let error = null;
    try {
      await Promise.race([
        run(tools),
        new Promise((_, reject) => { setTimeout(() => reject(new Error(`timed out after ${meta.timeoutMs / 1000}s`)), meta.timeoutMs); }),
      ]);
      const unexpected = chat.dialogs.filter((dialog) => !meta.allowDialogs);
      if (unexpected.length > 0) {
        throw new Error(`unexpected browser dialog(s): ${unexpected.map((dialog) => JSON.stringify(dialog.message)).join(', ')}`);
      }
    } catch (caught) {
      error = caught;
      await snapshot('at the failure');
      await chat.capture(artifacts, 'failure');
      fs.writeFileSync(path.join(artifacts, 'server.log'), serverLog(600));
      fs.writeFileSync(path.join(artifacts, 'details.json'), JSON.stringify({
        error: String(caught?.stack || caught),
        dialogs: chat.dialogs,
        consoleErrors: chat.consoleErrors.slice(-50),
        detachedProcesses: detachedProcesses(paths),
        url: page.url(),
      }, null, 2));
    }
    if (!error) {
      await snapshot('at the end');
    }
    await context.close();

    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    results.push({
      name, title: meta.title, description: meta.description ?? readScenarioDescription(path.join(scenarioDir, file)),
      passed: !error, seconds, error: error ? String(error.message || error) : null,
      artifacts: error ? artifacts : null, steps, images,
    });
    log(error ? `✗ ${name} (${seconds}s): ${error.message}` : `✓ ${name} (${seconds}s)`);
  }
} catch (setupError) {
  log(`setup failed: ${setupError.stack || setupError}`);
  results.push({ name: 'setup', passed: false, error: String(setupError.message || setupError) });
} finally {
  await browser?.close().catch(() => {});
  let unit = null;
  if (args['with-unit']) {
    log('running the unit tests behind the same guarantees');
    unit = runUnitTests(repoDir, UNIT_TEST_FILES, execFileSync);
    const failedUnits = unit.files.reduce((sum, file) => sum + file.failed, 0);
    log(failedUnits ? `unit tests: ${failedUnits} failed` : `unit tests: all ${unit.files.reduce((sum, file) => sum + file.passed, 0)} passed`);
  }
  const run = {
    startedAt, host: os.hostname(), appDir, port, runDir: paths.runDir, artifacts: paths.artifacts,
    commit: gitInfo.commit, dirty: gitInfo.dirty, model: 'Haiku 4.5',
    detached: process.env.E2E_DETACHED ?? '1', ceilingMs: process.env.E2E_BG_WAIT_CEILING_MS ?? '20000',
    results, unit,
  };
  fs.mkdirSync(paths.artifacts, { recursive: true });
  fs.writeFileSync(path.join(paths.artifacts, 'report.json'), JSON.stringify(run, null, 2));
  const reportFile = writeReport(run, path.join(paths.artifacts, 'report.html'));
  // A copy in the repo (ignored by git), so the latest report is easy to find.
  const reportsDir = path.join(repoDir, 'custom', 'e2e', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.copyFileSync(reportFile, path.join(reportsDir, `${startedAt.slice(0, 19).replace(/[:T]/g, '-')}.html`));
  fs.copyFileSync(reportFile, path.join(reportsDir, 'latest.html'));
  log(`report: ${path.join(reportsDir, 'latest.html')}`);
  // Also where the live CloudCLI serves static files from (public/, ahead of
  // dist/, and untouched by builds): the report is then a link in the browser,
  // behind whatever protects the app. Ignored by git.
  const publicDir = path.join(repoDir, 'public', 'e2e-reports');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.copyFileSync(reportFile, path.join(publicDir, 'latest.html'));
  fs.copyFileSync(reportFile, path.join(publicDir, `${startedAt.slice(0, 19).replace(/[:T]/g, '-')}.html`));
  const publicUrl = readDotEnv(path.join(repoDir, '.env'), 'PUBLIC_URL');
  log(`report URL: ${publicUrl ? `${publicUrl.replace(/\/$/, '')}/e2e-reports/latest.html` : '<app url>/e2e-reports/latest.html'}`);
  const keep = Boolean(args.keep) || results.some((result) => !result.passed);
  // A failing run keeps its whole folder; artifacts (with the report) always stay.
  cleanup({ paths, keep, log });
}

console.log('\n──────── e2e summary ────────');
for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'}  ${result.name.padEnd(32)} ${result.seconds ?? '-'}s  ${result.passed ? '' : result.error}`);
  if (result.artifacts) {
    console.log(`      artifacts: ${result.artifacts}`);
  }
}
const failed = results.filter((result) => !result.passed).length;
console.log(failed ? `\n${failed} of ${results.length} failed` : `\nall ${results.length} passed`);
process.exit(failed ? 1 : 0);
