// A page reload while Claude works (F5, a dropped tab): the reloaded page
// picks the running turn back up and shows its end.
export const meta = {
  title: 'Reloading the page mid-turn resumes the stream',
  timeoutMs: 150000,
};

export async function run({ chat, page, expect, sleep, processes }) {
  await chat.openNewChat();
  await chat.send('Use the Bash tool to run exactly `python3 -c "import time; time.sleep(20)"`. When it has finished, reply with the single word RELOADED.');
  const sessionId = await chat.sessionId();
  await chat.waitWorking();
  await sleep(3000);
  const [before] = processes(sessionId);

  await page.reload();
  await chat.composer().waitFor({ timeout: 20000 });
  await sleep(1500);
  expect(await chat.isWorking(), 'after the reload the page shows the turn still running');
  await chat.waitForAssistant(/RELOADED/, 90000);
  await chat.waitIdle(30000);
  const after = processes(sessionId);
  expect(after.length === 0 || after[0].pid === before.pid, 'the same process finished the turn');
}
