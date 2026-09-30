// A scheduled message that comes due while Claude is working joins the
// running turn instead of aborting it: the turn still finishes, and the
// scheduled request is answered by the same process.
export const meta = {
  title: 'A scheduled message due mid-turn joins the turn instead of aborting it',
  timeoutMs: 240000,
};

export async function run({ chat, app, expect, processes, log }) {
  await chat.openNewChat();
  await chat.send('Use the Bash tool to run exactly `python3 -c "import time; time.sleep(50)"`. When it has finished, reply with DONE1.');
  const sessionId = await chat.sessionId();
  await chat.waitWorking();
  const [before] = processes(sessionId);

  // Due already; the dispatcher polls every 30s.
  const response = await fetch(`${app.base}/api/scheduled-messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.token}` },
    body: JSON.stringify({ sessionId, content: 'Also include the word MANGO in your final reply.', scheduledFor: new Date(Date.now() - 1000).toISOString(), options: {} }),
  });
  expect(response.status === 201, 'the message was scheduled');
  log('waiting for the dispatcher (polls every 30s)');

  const replies = await chat.waitForAssistant(/MANGO/, 150000);
  expect(/DONE1/.test(replies), 'the running turn was not aborted: it finished with DONE1');
  const after = processes(sessionId);
  expect(after.length === 0 || after[0].pid === before.pid, 'the same process answered');
}
