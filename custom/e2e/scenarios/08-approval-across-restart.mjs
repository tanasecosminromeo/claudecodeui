import fs from 'node:fs';

// A restart while Claude waits on a tool approval: the prompt went to the old
// server and nobody can answer it any more, so the reattached session stops
// that step and says so in the chat, and the session is usable right after.
export const meta = {
  title: 'Restart while an approval is pending: step stopped with a note, session usable',
  timeoutMs: 240000,
  mode: 'default',
};

export async function run({ chat, expect, restart, projectFile, snapshot }) {
  await chat.openNewChat();
  await chat.send('Use the Bash tool to run exactly `touch approval-proof.txt`, then reply TOUCHED.');
  await chat.waitForApprovalPrompt(90000);
  expect(true, 'Claude is waiting on the approval');
  await snapshot('the approval prompt, just before the restart');

  await restart();
  const deadline = Date.now() + 90000;
  let transcript = '';
  while (Date.now() < deadline && !/waiting for your approval when CloudCLI restarted/.test(transcript)) {
    await chat.page.waitForTimeout(1000);
    transcript = await chat.transcriptText();
  }
  expect(/waiting for your approval when CloudCLI restarted/.test(transcript), 'the chat explains the step was stopped');
  await snapshot('after the restart: the note in the chat');
  expect(!fs.existsSync(projectFile('approval-proof.txt')), 'the unapproved command did not run');
  await chat.waitIdle(60000);

  await chat.setMode('bypassPermissions');
  await chat.send('Reply with the single word AFTER.');
  await chat.waitForAssistant(/AFTER/, 90000);
  expect(true, 'the session answers after the restart');
}
