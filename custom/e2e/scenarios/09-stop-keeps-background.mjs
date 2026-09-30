// Stop ends the turn, not the session's background work: like Esc in the CLI.
// (The foreground wait is a python sleep: the CLI refuses a foreground command
// that starts with a long `sleep`.)
// The backgrounded command keeps its process, the next message goes to that
// same process, and the command still reports back when it finishes.
export const meta = {
  title: 'Stop ends the turn but keeps background work and its process',
  timeoutMs: 240000,
};

export async function run({ chat, expect, sleep, processes, snapshot }) {
  await chat.openNewChat();
  await chat.send(
    'Use the Bash tool with run_in_background=true to run exactly `sleep 40; echo BGDONE`. '
    + 'Then use the Bash tool in the foreground to run exactly `python3 -c "import time; time.sleep(30); print(\'FGDONE\')"`. Then reply DONE1.',
  );
  const sessionId = await chat.sessionId();
  let running = [];
  for (let i = 0; i < 60 && !(running[0]?.tasks?.length); i++) {
    await sleep(1000);
    running = processes(sessionId);
  }
  expect(running.length === 1 && running[0].tasks.length >= 1, `the background command is running (pid ${running[0]?.pid})`);
  await sleep(4000);

  expect(await chat.isWorking(), 'the turn is still running (foreground command) when Stop is pressed');
  await chat.stopTurn();
  await chat.waitIdle(30000);
  expect(true, 'Stop ended the turn');
  await sleep(3000);
  const afterStop = processes(sessionId);
  expect(afterStop.length === 1 && afterStop[0].pid === running[0].pid, 'the process is still up after Stop');
  expect(afterStop[0].tasks.length >= 1, 'the background command is still outstanding');
  await snapshot('after Stop: the background work still shown');

  const repliesBefore = await chat.assistantMessageCount();
  await chat.send('Reply with the single word STILLHERE.');
  await chat.waitForAssistant(/STILLHERE/, 60000);
  expect(processes(sessionId)[0]?.pid === running[0].pid, 'the next message went to the same process');

  await chat.waitForNewAssistant(/BGDONE|background/i, repliesBefore, 90000);
  expect(true, 'the background command reported back after Stop');
}
