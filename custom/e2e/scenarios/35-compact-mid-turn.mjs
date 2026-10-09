// /compact sent while a turn runs: the CLI does not fold it into the turn but
// runs it right after the turn's result, as a run of its own. The message
// shows as sent at once; the server keeps the turn open for that run instead
// of letting the process go under it (which, detached, killed the CLI
// mid-compaction and left "Compacting conversation…" stuck). The turn's own
// reply is intact, one "Compacted · manual" row follows, and the session
// ends idle with its process gone.
export const meta = {
  title: '/compact sent mid-turn runs after the turn: reply intact, one "Compacted · manual" row, session idle',
  timeoutMs: 300000,
};

const ROW = /Compacted · manual/g;

export async function run({ chat, page, expect, sleep, processes }) {
  await chat.openNewChat();
  await chat.send(
    'Use the Bash tool to run exactly: python3 -c "import time; time.sleep(15)"; echo SLEPT . '
    + 'Then reply with the single word FINISHED and nothing else.',
  );
  const sessionId = await chat.sessionId();
  await chat.waitWorking(30000);
  // Into the tool call (its block shows the command), so the push lands
  // mid-turn rather than before it.
  await chat.waitForAssistant(/time\.sleep\(15\)/, 60000);
  await sleep(2000);
  expect(await chat.isWorking(), 'the turn is still running');

  // Typed as a person does: the menu narrows to /compact, Enter picks it
  // (writing it into the composer), Enter again sends it. (`chat.send` fills
  // and presses Enter at once, before the menu has narrowed, so Enter would
  // pick whatever the unfiltered menu shows first.)
  await chat.composer().click();
  await chat.composer().pressSequentially('/compact');
  await page.getByRole('listbox', { name: 'Available commands' }).getByRole('option')
    .first().filter({ hasText: '/compact' }).waitFor({ timeout: 10000 });
  await chat.composer().press('Enter');
  const typed = await chat.composer().inputValue();
  expect(typed === '/compact ', `Enter picks it from the menu ("${typed}")`);
  await chat.composer().press('Enter');
  await page.locator('.chat-message:not(.assistant)').filter({ hasText: '/compact' }).first()
    .waitFor({ timeout: 5000 });
  expect(true, 'the command shows as sent at once');

  await chat.waitForAssistant(/FINISHED/, 120000);
  expect(true, 'the turn\'s own reply arrived');
  await chat.waitForAssistant(/Compacted · manual/, 180000);
  await chat.waitIdle(60000);
  await sleep(2000);

  const text = await chat.assistantText();
  expect(/FINISHED/.test(text), 'the turn\'s reply is intact');
  expect((text.match(ROW) || []).length === 1, 'one "Compacted · manual" row');
  expect(!/Compacting conversation…/.test(text), 'no "Compacting conversation…" row left behind');
  expect(!(await chat.isWorking()), 'the session ends idle');
  for (let i = 0; i < 15 && processes(sessionId).length > 0; i++) {
    await sleep(1000);
  }
  expect(processes(sessionId).length === 0, 'and its process is gone, nothing left held');

  await page.reload();
  await chat.waitForAssistant(/Compacted · manual/, 30000);
  const reloaded = await chat.assistantText();
  expect((reloaded.match(ROW) || []).length === 1, 'after a reload, still one "Compacted · manual" row');
  expect(/FINISHED/.test(reloaded), 'and the reply');
}
