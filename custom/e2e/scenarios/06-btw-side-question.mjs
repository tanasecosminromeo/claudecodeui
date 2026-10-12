// /btw asks a side question while Claude works: the panel opens with the entry
// pending, the main composer stays usable (a message sent meanwhile joins the
// turn), the answer arrives in the panel, the running turn is not interrupted,
// and neither the question nor the answer is added to the conversation. After
// a reload the panel still lists it, and Start session seeds a new chat.
export const meta = {
  title: '/btw while busy: answered in the side panel, the chat stays usable, kept after a reload, starts a session',
  timeoutMs: 240000,
};

export async function run({ chat, page, expect, snapshot }) {
  await chat.openNewChat();
  await chat.send('Use the Bash tool to run exactly `python3 -c "import time; time.sleep(30)"` in the foreground. When it has finished, reply with FINISHED.');
  const sessionId = await chat.sessionId();
  await chat.waitWorking();
  await page.waitForTimeout(4000);

  await chat.send('/btw What exact shell command did I ask you to run? Answer in one line.');
  const panel = page.getByRole('complementary', { name: 'Side questions' });
  await panel.waitFor({ state: 'visible', timeout: 15000 });
  expect(await page.locator('[role=dialog]').count() === 0, 'no popup: the answer goes to the panel');
  expect(await chat.isWorking(), 'the main turn is still running');

  // The main composer works while the side question is pending.
  await chat.send('Also, after FINISHED, add the word GRAPEFRUIT on its own line.');
  expect(true, 'a message was sent in the main chat while the side question was open');

  await panel.getByText(/time\.sleep\(30\)/).first().waitFor({ timeout: 90000 });
  expect(true, 'the answer appeared in the panel and names the command');
  expect(await chat.isWorking(), 'the main turn was still running when the answer arrived');
  await snapshot('the /btw answer in the side panel while the turn runs');

  await chat.waitForAssistant(/FINISHED/, 120000);
  await chat.waitIdle(60000);
  const transcript = await chat.transcriptText();
  expect(!/What exact shell command/.test(transcript), 'the side question is not in the conversation');
  expect(/GRAPEFRUIT/.test(await chat.assistantText()), 'Claude acted on the message sent while the side question was pending');

  // Kept across a reload: the panel reads the stored entries.
  await page.reload();
  await chat.composer().waitFor({ timeout: 20000 });
  await panel.waitFor({ state: 'visible', timeout: 15000 });
  await panel.getByText(/What exact shell command/).first().waitFor({ timeout: 15000 });
  expect(true, 'after a reload the panel still lists the side question');

  // Start session: a new chat whose composer holds the seed; nothing is sent.
  await panel.getByRole('button', { name: 'Start session' }).first().click();
  await page.waitForFunction(
    (id) => [...document.querySelectorAll('textarea')].some((box) => box.value.includes(id)),
    sessionId,
    { timeout: 15000 },
  );
  const seed = await chat.composer().inputValue();
  expect(seed.startsWith('Started from a side question in session'), 'the new chat is seeded with where it came from');
  expect(seed.includes(`(${sessionId})`), 'the seed names the original session id');
  expect(/Its transcript is at \S+\.jsonl/.test(seed), 'the seed names the transcript path');
  expect(/Question: What exact shell command/.test(seed) && /Answer:\n.*time\.sleep/s.test(seed), 'the seed holds the question and the answer');
  expect(!page.url().includes(sessionId), 'it is a new chat, not the original session');
  await snapshot('a new chat seeded from the side question');
}
