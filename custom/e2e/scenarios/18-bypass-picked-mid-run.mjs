import fs from 'node:fs';

// Bypass picked while a process launched in another mode is running: the CLI
// refuses to switch into bypass after launch, so the app approves on the
// user's behalf instead — the next edit does not ask.
export const meta = {
  title: 'Bypass picked mid-run: later tools run without asking although the CLI cannot switch',
  timeoutMs: 180000,
  mode: 'default',
};

export async function run({ chat, expect, sleep, projectFile }) {
  await chat.openNewChat();
  await chat.send('Use the Write tool to create c.txt containing c. Then use the Write tool to create d.txt containing d. Then reply DONE.');
  await chat.waitForApprovalPrompt(90000);
  await chat.setMode('bypassPermissions');
  await chat.allowOnce();

  let promptedAgain = false;
  for (let i = 0; i < 90 && !fs.existsSync(projectFile('d.txt')); i++) {
    await sleep(1000);
    promptedAgain = promptedAgain || await chat.hasApprovalPrompt();
  }
  expect(fs.existsSync(projectFile('d.txt')), 'the second file was written');
  expect(!promptedAgain, 'without asking again');
  await chat.waitForAssistant(/DONE/, 60000);
}
