// The same session open in two browser tabs: both follow the stream, a
// message sent from the second tab while the first tab's turn runs joins
// that turn, and there is still exactly one Claude process.
export const meta = {
  title: 'Two tabs on one session: both stream, a send from either joins the one process',
  timeoutMs: 180000,
};

export async function run({ chat, page, app, expect, sleep, processes, snapshot }) {
  await chat.openNewChat();
  await chat.send('Use the Bash tool to run exactly `python3 -c "import time; time.sleep(20)"`. When it has finished, reply with DONE1.');
  const sessionId = await chat.sessionId();
  await chat.waitWorking();
  // The composer shows Stop as soon as the message is sent; the process
  // record appears once the server has spawned the process.
  let before = null;
  for (let i = 0; i < 30 && !before; i++) {
    await sleep(500);
    [before] = processes(sessionId);
  }
  expect(Boolean(before), `one Claude process runs the turn (pid ${before?.pid})`);

  const second = await page.context().newPage();
  const { ChatPage } = await import('../lib/chat.mjs');
  const other = new ChatPage(second, { base: app.base, projectName: 'e2e-project' });
  await second.goto(`${app.base}/session/${sessionId}`);
  await other.composer().waitFor({ timeout: 20000 });
  await sleep(2000);
  expect(await other.isWorking(), 'the second tab shows the turn running');

  await other.send('Also include the word BANANA in your final reply.');
  const inSecond = await other.waitForAssistant(/BANANA/, 90000);
  expect(/DONE1/.test(inSecond), 'the second tab got the reply covering both messages');
  await chat.waitForAssistant(/BANANA/, 30000);
  expect(true, 'the first tab got it too');
  await snapshot('the first tab, with the reply covering both messages');
  const after = processes(sessionId);
  expect(after.length <= 1 && (after.length === 0 || after[0].pid === before.pid), 'never a second Claude process');
  await second.close();
}
