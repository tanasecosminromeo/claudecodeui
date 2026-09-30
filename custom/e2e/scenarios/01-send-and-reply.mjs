// Smoke test: a new chat, one message, one reply — the baseline every other
// scenario builds on. If this fails, look at setup (model, login, project).
export const meta = {
  title: 'A new chat sends a message and shows the reply',
  timeoutMs: 90000,
};

export async function run({ chat, expect }) {
  await chat.openNewChat();
  await chat.send('Reply with the single word PINEAPPLE and nothing else.');
  const sessionId = await chat.sessionId();
  expect(Boolean(sessionId), `the chat got a session id (${sessionId})`);
  await chat.waitForAssistant(/PINEAPPLE/, 60000);
  await chat.waitIdle(30000);
  expect(true, 'Claude replied and the session went idle');
}
