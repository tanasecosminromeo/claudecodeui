import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// A session started in a terminal that stops on a permission prompt: its page here cannot answer
// the prompt (it belongs to the terminal's claude), so a banner above the composer says what it
// waits for and where to answer it. The banner goes once the terminal's claude is gone.
export const meta = {
  title: 'A terminal session waiting on a permission prompt shows a banner above the composer',
  timeoutMs: 180000,
};

/** Live registry entries (~/.claude/sessions) of processes working in `cwd`. */
function registryEntriesIn(cwd) {
  const dir = path.join(process.env.HOME, '.claude', 'sessions');
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((file) => {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (entry.cwd !== cwd) return [];
      process.kill(entry.pid, 0);
      return [entry];
    } catch {
      return [];
    }
  });
}

export async function run({ page, app, expect, sleep, paths, log, snapshot }) {
  const marker = `wait-check-${Date.now()}.txt`;
  fs.mkdirSync(paths.artifacts, { recursive: true });
  const screenLog = path.join(paths.artifacts, '31-terminal-screen.log');
  // A clean environment, like a terminal you open yourself (see 07-terminal-takeover).
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDECODE'));
  // Default permission mode on purpose: the user's settings may default to auto, which could
  // approve the command without asking.
  const prompt = `Use the Bash tool to run exactly: touch ${marker}`;
  const terminal = spawn('script', ['-qfc', `claude --model haiku --permission-mode default '${prompt}'`, screenLog], {
    cwd: paths.project, env, stdio: ['pipe', 'ignore', 'ignore'], detached: true,
  });
  const before = new Set(registryEntriesIn(paths.project).map((entry) => entry.pid));
  let entry = null;
  try {
    for (let i = 0; i < 90 && !(entry && entry.status === 'waiting'); i++) {
      await sleep(1000);
      entry = registryEntriesIn(paths.project).find((e) => e.entrypoint === 'cli' && !before.has(e.pid)) || null;
      // A folder Claude Code has not seen opens on the trust question with "No, exit" selected.
      if (!entry && i === 5) {
        log('answering the folder-trust question in the terminal');
        terminal.stdin.write('\x1b[B');
        await sleep(300);
        terminal.stdin.write('\r');
      }
    }
    expect(Boolean(entry), 'the terminal claude registered itself');
    if (entry.status !== 'waiting' && fs.existsSync(path.join(paths.project, marker))) {
      throw new Error('the command ran without a prompt: a permission rule allowed it, so this scenario tests nothing');
    }
    expect(entry.status === 'waiting', `the terminal claude waits on a prompt (status ${entry.status}, ${entry.waitingFor})`);

    await page.goto(`${app.base}/session/${entry.sessionId}`);
    const banner = page.locator('[data-uic-wait-banner]');
    await banner.waitFor({ timeout: 20000 });
    const text = await banner.innerText();
    log(`banner: ${text.replace(/\s+/g, ' ')}`);
    expect(/Waiting in a terminal/.test(text), 'the banner says the session waits in a terminal');
    expect(text.includes(marker), 'the banner shows the command the prompt is about');
    expect(/take the session over/.test(text), 'the banner says how to take it over');
    await snapshot('banner above the composer');

    log('stopping the terminal');
    try { process.kill(-terminal.pid, 'SIGKILL'); } catch { /* gone */ }
    await banner.waitFor({ state: 'detached', timeout: 20000 });
    expect(true, 'the banner goes once the terminal claude is gone');
  } finally {
    try { process.kill(-terminal.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}
