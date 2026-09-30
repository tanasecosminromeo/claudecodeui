import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// A session open in a terminal (`claude --resume <id>`) is never joined by a
// second process from the web chat: sending asks whether to take it over;
// accepting stops the terminal's process and the message runs here.
export const meta = {
  title: 'A session open in a terminal: sending asks to take over; accepting stops the terminal',
  timeoutMs: 240000,
  allowDialogs: true,
};

function providerSessionIdFor(paths) {
  const dir = path.join(process.env.HOME, '.claude', 'projects', paths.project.replace(/[^A-Za-z0-9]/g, '-'));
  const newest = fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl'))
    .map((file) => ({ file, mtime: fs.statSync(path.join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  return newest?.file.replace(/\.jsonl$/, '');
}

/** Live registry entries (~/.claude/sessions) of processes working in `cwd`. */
function registryEntriesIn(cwd) {
  const dir = path.join(process.env.HOME, '.claude', 'sessions');
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).flatMap((file) => {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (entry.cwd !== cwd) {
        return [];
      }
      process.kill(entry.pid, 0);
      return [entry];
    } catch {
      return [];
    }
  });
}

export async function run({ chat, expect, sleep, processes, paths, log }) {
  await chat.openNewChat();
  await chat.send('Reply with the single word READY.');
  const sessionId = await chat.sessionId();
  await chat.waitForAssistant(/READY/, 60000);
  await chat.waitIdle(30000);
  for (let i = 0; i < 15 && processes(sessionId).length > 0; i++) {
    await sleep(1000);
  }
  expect(processes(sessionId).length === 0, 'the web chat has no process on the session any more');

  const providerSessionId = providerSessionIdFor(paths);
  expect(Boolean(providerSessionId), `found the transcript id ${providerSessionId}`);

  // A real terminal: `claude --resume` in a pseudo-terminal, stdin kept open.
  fs.mkdirSync(paths.artifacts, { recursive: true });
  const screenLog = path.join(paths.artifacts, '07-terminal-screen.log');
  // A clean environment, like a terminal you open yourself. Run from inside a
  // Claude Code session (an agent running these tests), the markers it passes
  // to its children make the new claude a "child session" that neither saves
  // its transcript nor registers in ~/.claude/sessions.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('CLAUDE_CODE_') && key !== 'CLAUDECODE'));
  const terminal = spawn('script', ['-qfc', `claude --resume ${providerSessionId}`, screenLog], {
    cwd: paths.project, env, stdio: ['pipe', 'ignore', 'ignore'], detached: true,
  });
  let terminalPid = null;
  try {
    for (let i = 0; i < 60 && !terminalPid; i++) {
      await sleep(1000);
      const entries = registryEntriesIn(paths.project).filter((entry) => entry.entrypoint === 'cli');
      terminalPid = entries.find((entry) => entry.sessionId === providerSessionId)?.pid ?? null;
      if (!terminalPid && entries.length > 0 && i % 10 === 9) {
        log(`a terminal claude runs in the folder on another session: ${JSON.stringify(entries.map((entry) => entry.sessionId))}`);
      }
      // A folder Claude Code has not seen opens on "Is this a project you
      // trust?" with "No, exit" selected: pick "Yes, I trust this folder".
      // Claude Code remembers the answer in ~/.claude.json, so later runs skip it.
      if (!terminalPid && i === 5) {
        log('answering the folder-trust question in the terminal');
        terminal.stdin.write('\x1b[B');
        await sleep(300);
        terminal.stdin.write('\r');
      }
    }
    expect(Boolean(terminalPid), `the terminal claude registered itself on the session (pid ${terminalPid})`);

    chat.onDialog = async (dialog) => /open in a terminal/.test(dialog.message);
    await chat.send('Reply with the single word TAKEN.');
    for (let i = 0; i < 30 && chat.dialogs.length === 0; i++) {
      await sleep(500);
    }
    expect(chat.dialogs.length === 1 && /open in a terminal/.test(chat.dialogs[0].message), `the web chat asked to take over (${chat.dialogs[0]?.message?.split('\n')[0]})`);
    expect(chat.dialogs[0].accepted, 'the take-over was accepted');

    await chat.waitForAssistant(/TAKEN/, 90000);
    let terminalAlive = true;
    for (let i = 0; i < 20 && terminalAlive; i++) {
      try { process.kill(terminalPid, 0); await sleep(500); } catch { terminalAlive = false; }
    }
    expect(!terminalAlive, 'the terminal claude was stopped');
  } finally {
    log('stopping the terminal');
    try { process.kill(-terminal.pid, 'SIGKILL'); } catch { /* gone */ }
  }
}
