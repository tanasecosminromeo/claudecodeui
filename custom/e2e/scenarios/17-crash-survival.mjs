// The server dies without any shutdown handler running (SIGKILL: a crash, an
// OOM kill) mid-turn. The Claude process survives that too, and the server
// started afterwards reattaches exactly as after a clean restart.
export const meta = {
  title: 'The server killed with SIGKILL mid-turn: the process survives, the turn finishes',
  timeoutMs: 240000,
};

export async function run({ chat, expect, sleep, crash, processes }) {
  await chat.openNewChat();
  await chat.send('Use the Bash tool to run exactly `python3 -c "import time; time.sleep(25)"`. When it has finished, reply with the single word SURVIVED.');
  const sessionId = await chat.sessionId();
  await chat.waitWorking();
  await sleep(4000);
  const [before] = processes(sessionId);
  expect(Boolean(before), `one process runs the turn (pid ${before?.pid})`);

  await crash();
  const after = processes(sessionId);
  expect(after.length === 1 && after[0].pid === before.pid, 'the process survived the crash');
  await chat.waitForAssistant(/SURVIVED/, 120000);
  await chat.waitIdle(30000);
  await chat.send('Reply with the single word AGAIN.');
  await chat.waitForAssistant(/AGAIN/, 60000);
  expect(true, 'the session works after the crash');
}
