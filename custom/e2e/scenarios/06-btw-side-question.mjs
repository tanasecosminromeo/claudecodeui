// /btw asks a side question while Claude works: the answer shows in a popup
// right away, the running turn is not interrupted, and neither the question
// nor the answer is added to the conversation.
export const meta = {
  title: '/btw while busy: answered in a popup, turn continues, transcript untouched',
  timeoutMs: 180000,
};

export async function run({ chat, page, expect, snapshot }) {
  await chat.openNewChat();
  await chat.send('Use the Bash tool to run exactly `sleep 25; echo SLEPT`. When it has finished, reply with FINISHED.');
  await chat.waitWorking();
  await page.waitForTimeout(4000);

  await chat.send('/btw What exact shell command did I ask you to run? Answer in one line.');
  const popup = page.locator('[role=dialog]').filter({ hasText: /sleep 25/ });
  await popup.waitFor({ state: 'visible', timeout: 90000 });
  expect(true, 'the /btw answer appeared in a popup and names the command');
  await snapshot('the /btw answer while the turn runs');
  expect(await chat.isWorking(), 'the main turn is still running');

  await page.keyboard.press('Escape');
  await chat.waitForAssistant(/FINISHED/, 90000);
  const transcript = await chat.transcriptText();
  expect(!/What exact shell command/.test(transcript), 'the side question is not in the conversation');
}
