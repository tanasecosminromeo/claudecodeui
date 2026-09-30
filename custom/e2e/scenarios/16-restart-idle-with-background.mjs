// A restart while the session is idle but holding its process for background
// work: the process survives, the session is not shown as busy, the work is
// still tracked, and — with the untracked-work ceiling set short for these
// tests — tracked work outlives that ceiling and still reports back.
export const meta = {
  title: 'Restart while idle with background work: process kept, not busy, work outlives the short ceiling',
  timeoutMs: 240000,
};

export async function run({ chat, expect, sleep, restart, processes, snapshot }) {
  await chat.openNewChat();
  await chat.send('Use the Bash tool with run_in_background=true to run exactly `sleep 70; echo BGDONE`. Do not wait for it. Reply STARTED only.');
  const sessionId = await chat.sessionId();
  await chat.waitForAssistant(/STARTED/, 60000);
  await chat.waitIdle(30000);
  const [before] = processes(sessionId);
  expect(before?.tasks.length >= 1, `the process is held for the command (pid ${before?.pid})`);
  const repliesBefore = await chat.assistantMessageCount();

  await restart();
  await sleep(3000);
  expect(!(await chat.isWorking()), 'the session is not shown as busy after the restart');
  const after = processes(sessionId);
  expect(after.length === 1 && after[0].pid === before.pid, 'the same process survived');
  expect(after[0].tasks.length >= 1, 'its background command is still tracked');
  await snapshot('after the restart: idle, background work still shown');

  // Past the (20s) ceiling for work the runtime cannot track: tracked work
  // is held as long as it runs.
  await sleep(25000);
  expect(processes(sessionId)[0]?.pid === before.pid, 'still held 25s later');

  await chat.waitForNewAssistant(/BGDONE|background/i, repliesBefore, 90000);
  expect(true, 'the background command reported back after the restart');
  let left = processes(sessionId).length;
  for (let i = 0; i < 20 && left > 0; i++) {
    await sleep(1000);
    left = processes(sessionId).length;
  }
  expect(left === 0, 'the process exited once its work was done');
}
