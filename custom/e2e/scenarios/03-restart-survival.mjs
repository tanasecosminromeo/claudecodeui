// The headline guarantee of detached Claude processes: a CloudCLI restart
// (systemctl restart — what `make restart` does) mid-turn loses nothing. The
// same Claude process keeps running in its own systemd scope, the restarted
// server reattaches, the browser reconnects on its own and shows the rest of
// the turn, the next message goes to the same process, and background work
// started before the restart still reports back.
export const meta = {
  title: 'A service restart mid-turn: same process, turn finishes, background work reports',
  timeoutMs: 300000,
};

export async function run({ chat, expect, sleep, restart, processes, log, snapshot }) {
  await chat.openNewChat();
  await chat.send(
    'Use the Bash tool with run_in_background=true to run exactly `sleep 45; echo BGDONE`. '
    + 'Then use the Bash tool in the foreground to run exactly `sleep 20; echo FGDONE`. '
    + 'When the foreground command has finished, reply with DONE1.',
  );
  const sessionId = await chat.sessionId();
  await chat.waitWorking();

  // Wait until both commands are running: the background task is recorded.
  let before = [];
  for (let i = 0; i < 60 && !(before[0]?.tasks?.length); i++) {
    await sleep(1000);
    before = processes(sessionId);
  }
  expect(before.length === 1, `one detached Claude process (pid ${before[0]?.pid}) before the restart`);
  expect(before[0].tasks.length >= 1, 'the background command is recorded as outstanding');
  await sleep(3000);
  await snapshot('mid-turn, just before the restart');

  await restart();
  const after = processes(sessionId);
  expect(after.length === 1 && after[0].pid === before[0].pid, `the same process (pid ${before[0].pid}) survived the restart`);

  // The page reconnects by itself — no reload.
  const replies = await chat.waitForAssistant(/DONE1/, 120000);
  expect(/DONE1/.test(replies), 'the turn that was running during the restart finished in the browser');
  await snapshot('after the restart: the turn finished on the same page');
  // Anything after this row is new: the background report can land before or
  // after the next message, depending on when the 45s command ends.
  const repliesUpToDone = await chat.assistantMessageCount();
  await chat.waitIdle(60000);

  await chat.send('Reply with the single word PONG.');
  await chat.waitForAssistant(/PONG/, 60000);
  const afterPong = processes(sessionId);
  expect(afterPong.length === 1 && afterPong[0].pid === before[0].pid, 'the next message went to the same process');

  // The report is a turn of its own after DONE1. BGDONE on screen proves
  // nothing by itself — the command block already shows `echo BGDONE`.
  log('waiting for the background command to report');
  let outstanding = afterPong[0].tasks.length;
  for (let i = 0; i < 120 && outstanding > 0; i++) {
    await sleep(1000);
    outstanding = processes(sessionId)[0]?.tasks.length ?? 0;
  }
  expect(outstanding === 0, 'the runtime saw the background command finish (task no longer outstanding)');
  await chat.waitForNewAssistant(/BGDONE|background/i, repliesUpToDone, 90000);
  expect(true, 'a reply after DONE1 reported the background command');

  // Nothing is left for the process to do: it must be let go, not kept idle.
  await chat.waitIdle(60000);
  let left = processes(sessionId).length;
  for (let i = 0; i < 20 && left > 0; i++) {
    await sleep(1000);
    left = processes(sessionId).length;
  }
  expect(left === 0, 'the process exited once it had no work left');
}
