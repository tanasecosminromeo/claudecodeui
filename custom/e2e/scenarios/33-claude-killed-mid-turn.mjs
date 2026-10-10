// The Claude process of a session is killed from outside mid-turn (SIGKILL,
// as the OOM killer does it). Nothing asked it to stop, so the chat must not
// wait for it: the working state ends, the error says the process stopped,
// and the next message starts a fresh process.
export const meta = {
  title: 'The Claude process killed mid-turn: the chat stops working and says why, the next message starts a fresh process',
  timeoutMs: 180000,
};

export async function run({ chat, expect, sleep, processes }) {
  await chat.openNewChat();
  await chat.send('Use the Bash tool to run exactly `python3 -c "import time; time.sleep(60)"`. When it has finished, reply with the single word DONE.');
  const sessionId = await chat.sessionId();
  await chat.waitWorking();
  await sleep(4000);
  const [before] = processes(sessionId);
  expect(Boolean(before), `one process runs the turn (pid ${before?.pid})`);

  process.kill(before.pid, 'SIGKILL');

  let idle = true;
  try {
    await chat.waitIdle(15000);
  } catch {
    idle = false;
  }
  expect(idle, 'the chat leaves the working state within 15 s of the process being killed');

  let shown = false;
  for (let i = 0; i < 20 && !shown; i++) {
    shown = /stopped unexpectedly/.test(await chat.transcriptText());
    if (!shown) {
      await sleep(250);
    }
  }
  expect(shown, 'the chat shows that the Claude process stopped unexpectedly');

  await chat.send('Reply with the single word AGAIN.');
  await chat.waitForAssistant(/AGAIN/, 90000);
  await chat.waitIdle(30000);
  const [fresh] = processes(sessionId);
  expect(Boolean(fresh) && fresh.pid !== before.pid, `the next message ran in a fresh process (pid ${fresh?.pid})`);
}
