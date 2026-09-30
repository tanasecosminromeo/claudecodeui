// Sending while Claude works: the message goes into the running turn (like
// typing while Claude works in the CLI) instead of being queued or refused,
// no "Send anyway?" dialog appears, and no second Claude process is started.
export const meta = {
  title: 'A message sent mid-turn joins the running turn, no dialog, one process',
  timeoutMs: 150000,
};

export async function run({ chat, expect, sleep, processes }) {
  await chat.openNewChat();
  await chat.send('Use the Bash tool to run exactly `sleep 15; echo FGDONE`. When it has finished, reply with DONE1.');
  const sessionId = await chat.sessionId();
  await chat.waitWorking();
  await sleep(5000);
  expect(await chat.isWorking(), 'Claude is still working when the second message is sent');
  const [before] = processes(sessionId);
  expect(Boolean(before), `one Claude process runs the turn (pid ${before?.pid})`);

  await chat.send('Also include the word BANANA in your final reply.');
  await sleep(1500);
  expect(chat.dialogs.length === 0, 'no dialog was shown on sending mid-turn');
  const after = processes(sessionId);
  expect(after.length === 1 && after[0].pid === before.pid, 'still the same, single Claude process');

  const replies = await chat.waitForAssistant(/BANANA/, 90000);
  expect(/DONE1/.test(replies), 'the reply also finished the original request (DONE1)');
  await chat.waitIdle(30000);
}
