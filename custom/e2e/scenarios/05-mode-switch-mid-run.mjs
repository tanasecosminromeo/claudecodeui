import fs from 'node:fs';

// A permission mode picked while Claude is running applies to the running
// process right away, not only to the next message: after switching default →
// accept-edits during an approval prompt, the next edit in the same turn does
// not ask again.
export const meta = {
  title: 'Switching mode mid-run applies to the running turn',
  timeoutMs: 180000,
  mode: 'default',
};

export async function run({ chat, expect, sleep, projectFile, snapshot }) {
  await chat.openNewChat();
  await chat.send('Use the Write tool to create a.txt containing a. Then use the Write tool to create b.txt containing b. Then reply DONE.');
  await chat.waitForApprovalPrompt(90000);
  expect(true, 'default mode asked before the first write');
  await snapshot('the approval prompt in default mode');

  await chat.setMode('acceptEdits');
  expect(await chat.currentMode() === 'acceptEdits', 'switched to accept-edits while the prompt is open');
  await chat.allowOnce();

  let promptedAgain = false;
  for (let i = 0; i < 90 && !fs.existsSync(projectFile('b.txt')); i++) {
    await sleep(1000);
    promptedAgain = promptedAgain || await chat.hasApprovalPrompt();
  }
  expect(fs.existsSync(projectFile('a.txt')) && fs.existsSync(projectFile('b.txt')), 'both files were written');
  expect(!promptedAgain, 'the second write did not ask again');
  await chat.waitForAssistant(/DONE/, 60000);
}
