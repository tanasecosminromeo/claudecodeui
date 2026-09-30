// The run's report: one self-contained HTML file (screenshots embedded) that
// opens anywhere — every scenario with its steps, timing and pictures, the
// unit tests behind the same guarantees, and the run's setup.

import fs from 'node:fs';
import path from 'node:path';

const escape = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inlineImage(file) {
  try {
    const data = fs.readFileSync(file);
    const type = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    return `data:${type};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

const STYLE = `
  :root { --ok: #1a7f37; --bad: #cf222e; --ink: #1f2328; --muted: #656d76; --line: #d0d7de; --bg: #f6f8fa; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--ink); background: #fff; }
  main { max-width: 1100px; margin: 0 auto; padding: 32px 24px 80px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 20px; margin: 40px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 16px 0 8px; }
  .card { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; background: var(--bg); }
  .card .n { font-size: 26px; font-weight: 600; }
  .card .l { color: var(--muted); font-size: 13px; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .pill.ok { background: #dafbe1; } .pill.bad { background: #ffebe9; }
  details.scn { border: 1px solid var(--line); border-radius: 8px; margin: 12px 0; }
  details.scn > summary { cursor: pointer; padding: 12px 14px; display: flex; gap: 12px; align-items: baseline; }
  details.scn > summary .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); font-size: 13px; }
  details.scn > summary .title { font-weight: 600; flex: 1; }
  details.scn > summary .time { color: var(--muted); font-size: 13px; }
  .body { padding: 0 14px 14px; }
  .why { color: var(--muted); white-space: pre-wrap; margin: 4px 0 12px; }
  ul.steps { margin: 0 0 12px; padding-left: 4px; list-style: none; }
  ul.steps li { margin: 2px 0; }
  ul.steps li.note { color: var(--muted); }
  ul.steps li.note::before { content: "› "; }
  .err { background: #ffebe9; border: 1px solid #ff8182; border-radius: 6px; padding: 8px 12px; white-space: pre-wrap; font-family: ui-monospace, Menlo, monospace; font-size: 13px; }
  .shots { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 8px; }
  figure { margin: 0; width: 320px; }
  figure img { width: 100%; border: 1px solid var(--line); border-radius: 6px; cursor: zoom-in; }
  figcaption { font-size: 12px; color: var(--muted); margin-top: 4px; }
  dialog { border: none; padding: 0; background: transparent; max-width: 95vw; }
  dialog img { max-width: 95vw; max-height: 92vh; border-radius: 6px; box-shadow: 0 8px 40px rgba(0,0,0,.4); }
  dialog::backdrop { background: rgba(0,0,0,.6); }
  code { background: var(--bg); padding: 1px 5px; border-radius: 4px; font-size: 13px; }
  .files li { margin: 2px 0; }
`;

function scenarioSection(result) {
  const shots = (result.images ?? [])
    .map((image) => ({ ...image, src: inlineImage(image.file) }))
    .filter((image) => image.src)
    .map((image) => `<figure><img src="${image.src}" alt="${escape(image.label)}" loading="lazy" onclick="zoom(this)"><figcaption>${escape(image.label)}</figcaption></figure>`)
    .join('');
  const steps = (result.steps ?? []).map((step) => {
    if (step.kind === 'note') {
      return `<li class="note">${escape(step.text)}</li>`;
    }
    return `<li><span class="${step.ok ? 'ok' : 'bad'}">${step.ok ? '✓' : '✗'}</span> ${escape(step.text)}</li>`;
  }).join('');
  return `
<details class="scn"${result.passed ? '' : ' open'}>
  <summary>
    <span class="pill ${result.passed ? 'ok' : 'bad'}">${result.passed ? 'PASS' : 'FAIL'}</span>
    <span class="name">${escape(result.name)}</span>
    <span class="title">${escape(result.title ?? '')}</span>
    <span class="time">${escape(result.seconds ?? '-')}s</span>
  </summary>
  <div class="body">
    ${result.description ? `<p class="why">${escape(result.description)}</p>` : ''}
    <ul class="steps">${steps}</ul>
    ${result.error ? `<div class="err">${escape(result.error)}</div>` : ''}
    ${shots ? `<div class="shots">${shots}</div>` : ''}
  </div>
</details>`;
}

function unitSection(unit) {
  if (!unit) {
    return '';
  }
  const rows = unit.files.map((file) => `
<details class="scn">
  <summary>
    <span class="pill ${file.failed === 0 ? 'ok' : 'bad'}">${file.passed} / ${file.passed + file.failed}</span>
    <span class="name">${escape(file.file)}</span>
    <span class="title">${escape(file.about ?? '')}</span>
  </summary>
  <div class="body"><ul class="steps">${file.tests.map((test) => `<li><span class="${test.ok ? 'ok' : 'bad'}">${test.ok ? '✓' : '✗'}</span> ${escape(test.name)}</li>`).join('')}</ul></div>
</details>`).join('');
  const total = unit.files.reduce((sum, file) => sum + file.passed + file.failed, 0);
  const failed = unit.files.reduce((sum, file) => sum + file.failed, 0);
  return `
<h2>Unit tests behind the same guarantees</h2>
<p class="sub">${total} tests in ${unit.files.length} files, run with <code>${escape(unit.command)}</code>; ${failed === 0 ? 'all passed' : `<span class="bad">${failed} failed</span>`}.</p>
${rows}`;
}

/**
 * Writes `report.html` next to the artifacts. `run` carries the results with
 * their steps and images, the optional unit-test results, and the setup.
 */
export function writeReport(run, file) {
  const passed = run.results.filter((result) => result.passed).length;
  const failed = run.results.length - passed;
  const totalSeconds = run.results.reduce((sum, result) => sum + Number(result.seconds ?? 0), 0);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>CloudCLI e2e report — ${escape(run.startedAt.slice(0, 16).replace('T', ' '))}</title><style>${STYLE}</style></head>
<body><main>
<h1>CloudCLI end-to-end report</h1>
<p class="sub">${escape(run.startedAt.slice(0, 19).replace('T', ' '))} · ${escape(run.host)} · app <code>${escape(run.appDir)}</code> · commit <code>${escape(run.commit)}</code>${run.dirty ? ' (with uncommitted changes)' : ''}</p>
<div class="cards">
  <div class="card"><div class="n ${failed ? 'bad' : 'ok'}">${passed} / ${run.results.length}</div><div class="l">scenarios passed</div></div>
  <div class="card"><div class="n">${Math.round(totalSeconds / 60)} min</div><div class="l">of scenarios</div></div>
  <div class="card"><div class="n">${run.results.reduce((sum, result) => sum + (result.steps ?? []).filter((step) => step.kind === 'check').length, 0)}</div><div class="l">checks made</div></div>
  <div class="card"><div class="n">${run.results.reduce((sum, result) => sum + (result.images ?? []).length, 0)}</div><div class="l">screenshots</div></div>
</div>
<p class="sub">Each scenario drives a real, isolated CloudCLI instance (port ${escape(run.port)}, its own database, restarted with <code>systemctl</code>) with a real Claude CLI (${escape(run.model)}) in headless Chromium. Click a screenshot to enlarge.</p>

<h2>Scenarios</h2>
<table><tr><th></th><th>Scenario</th><th>Guarantee</th><th>Time</th></tr>
${run.results.map((result) => `<tr><td><span class="pill ${result.passed ? 'ok' : 'bad'}">${result.passed ? 'PASS' : 'FAIL'}</span></td><td><code>${escape(result.name)}</code></td><td>${escape(result.title ?? result.error ?? '')}</td><td>${escape(result.seconds ?? '-')}s</td></tr>`).join('')}
</table>

${run.results.map(scenarioSection).join('')}

${unitSection(run.unit)}

<h2>How this run was set up</h2>
<ul class="files">
  <li>Instance: transient user unit <code>${escape(run.unit?.unitName ?? 'cloudcli-e2e')}</code> from <code>${escape(run.appDir)}</code>, port ${escape(run.port)}, run folder <code>${escape(run.runDir)}</code></li>
  <li>Detached Claude processes: <code>CLOUDCLI_DETACHED_CLAUDE=${escape(run.detached)}</code>, untracked-work ceiling <code>${escape(run.ceilingMs)} ms</code> (30 min in production)</li>
  <li>Scenario files: <code>custom/e2e/scenarios/</code>; harness: <code>custom/e2e/run.mjs</code>, <code>custom/e2e/lib/</code>; docs: <code>custom/e2e/README.md</code></li>
  <li>Artifacts of this run: <code>${escape(run.artifacts)}</code></li>
</ul>
<dialog id="zoom" onclick="this.close()"><img alt=""></dialog>
<script>function zoom(img){const d=document.getElementById('zoom');d.querySelector('img').src=img.src;d.showModal();}</script>
</main></body></html>`;
  fs.writeFileSync(file, html);
  return file;
}

/**
 * Runs the unit test files that pin the same guarantees and collects each
 * test's name and outcome from the runner's output.
 */
export function runUnitTests(repoDir, files, execFileSync) {
  const command = 'npx tsx --tsconfig server/tsconfig.json --test <file>';
  const results = [];
  for (const { file, about } of files) {
    let output = '';
    try {
      output = execFileSync('npx', ['tsx', '--tsconfig', 'server/tsconfig.json', '--test', file], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
    } catch (error) {
      output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    }
    const tests = [];
    for (const line of output.split('\n')) {
      const match = line.match(/^(✔|✖) (.+?) \([\d.]+ms\)$/);
      if (match) {
        tests.push({ ok: match[1] === '✔', name: match[2] });
      }
    }
    results.push({ file, about, tests, passed: tests.filter((test) => test.ok).length, failed: tests.filter((test) => !test.ok).length });
  }
  return { command, files: results };
}

/** The unit test files written for the live-session work, with what each is about. */
export const UNIT_TEST_FILES = [
  { file: 'server/modules/providers/tests/claude-runtime-live-process.test.ts', about: 'One live process per session: mid-turn pushes, Stop, edits, the abort race, the overtaken result' },
  { file: 'server/modules/providers/tests/claude-runtime-hold.test.ts', about: 'Holding the process for background work and letting it go' },
  { file: 'server/modules/providers/tests/claude-runtime-reattach.test.ts', about: 'Reattaching after a restart: mid-turn, idle with work, nothing left, a lost approval' },
  { file: 'server/modules/providers/tests/claude-reattach-cleanup.test.ts', about: 'At restart: released, duplicate and orphaned processes are stopped' },
  { file: 'server/modules/providers/tests/claude-detached-process.test.ts', about: 'The detached process host: pipes, records, release, shutdown, a failed launch' },
  { file: 'server/modules/providers/tests/claude-live-processes.test.ts', about: 'Finding other Claude processes on a session (terminal, IDE); stale entries; own processes' },
  { file: 'server/modules/providers/tests/claude-permission-mode.test.ts', about: 'Plan approval keeps the chosen mode; mode switched mid-run; bypass mid-run' },
  { file: 'server/modules/providers/tests/claude-side-question.test.ts', about: '/btw: live process first, throwaway fork otherwise' },
  { file: 'server/modules/providers/tests/provider-runtime.service.test.ts', about: 'The dispatcher passes the new runtime calls through' },
  { file: 'server/modules/websocket/tests/chat-send-during-run.test.ts', about: 'A send during a run: into the turn, or waiting in order; refusals do not strand others' },
  { file: 'server/modules/websocket/tests/chat-session-elsewhere.test.ts', about: 'A session open in a terminal: refused, taken over on request, never by a schedule' },
  { file: 'server/modules/websocket/tests/chat-unseen-errors.test.ts', about: 'Notes raised while no browser watched reach the first subscriber; stale sequence numbers' },
  { file: 'server/modules/websocket/tests/chat-permission-mode.test.ts', about: 'The mode frames over the websocket' },
  { file: 'server/modules/websocket/tests/shell-websocket.service.test.ts', about: 'The Shell tab: guarded resume, terminals ended on shutdown' },
  { file: 'server/modules/scheduled-messages/tests/scheduled-messages.test.ts', about: 'A scheduled message joins a running turn instead of aborting it' },
  { file: 'server/modules/commands/tests/commands.test.ts', about: 'The /btw command' },
];
