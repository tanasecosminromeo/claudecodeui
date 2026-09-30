// The Shell tab on a session the chat is running: instead of a second
// `claude --resume` next to it, the terminal says where the session runs and
// asks; "no" leaves the user in a plain shell, with no second Claude process.
export const meta = {
  title: 'Shell tab on a session live in the chat asks before a second copy',
  timeoutMs: 180000,
};

export async function run({ chat, page, expect, sleep, processes, snapshot }) {
  await chat.openNewChat();
  await chat.send('Use the Bash tool with run_in_background=true to run exactly `sleep 90; echo BGDONE`. Do not wait for it. Reply STARTED only.');
  const sessionId = await chat.sessionId();
  await chat.waitForAssistant(/STARTED/, 60000);
  await chat.waitIdle(30000);
  expect(processes(sessionId).length === 1, 'the chat holds the session\'s process for its background work');

  // The terminal's output travels over the shell websocket.
  const output = [];
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/shell')) {
      return;
    }
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(String(payload));
        if (frame.type === 'output') {
          output.push(String(frame.data));
        }
      } catch { /* not JSON */ }
    });
  });
  await page.getByRole('tab', { name: 'Shell' }).click();
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !output.join('').includes('already running in the CloudCLI chat')) {
    await sleep(500);
  }
  expect(output.join('').includes('already running in the CloudCLI chat'), 'the terminal says the session is running in the chat');
  expect(output.join('').includes('Open a second copy anyway? [y/N]'), 'and asks before opening a second copy');
  await snapshot('the Shell tab asking before a second copy');

  // "No": a plain shell, and still one Claude process.
  await page.locator('.xterm').first().click();
  await page.keyboard.type('n');
  await page.keyboard.press('Enter');
  await sleep(3000);
  expect(processes(sessionId).length === 1, 'still exactly one Claude process for the session');
  // Leave the shell; an interactive shell left running would otherwise sit
  // in the service's cgroup (the server now ends terminals on shutdown too).
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await sleep(1000);
  await page.getByRole('tab', { name: 'Chat' }).click();
}
