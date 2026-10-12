// /compact on a chat with nothing to compact: the CLI refuses, reports the
// failure twice and repeats the reason as text. The chat shows it as one
// "Compaction failed: Not enough messages to compact." row, live and after a
// reload (where the transcript holds only the command's reply).
export const meta = {
  title: 'A refused /compact shows one "Compaction failed" row, live and after a reload',
  timeoutMs: 180000,
};

const REASON = /Not enough messages to compact/g;

export async function run({ chat, page, expect }) {
  // As the chat's first message: a single exchange in an app session already
  // carries enough context for the CLI to compact it.
  await chat.openNewChat();
  await chat.send('/compact');
  await chat.waitForAssistant(/Compaction failed: Not enough messages to compact\./, 60000);
  await chat.waitIdle(60000);
  // Give a late duplicate time to land before counting.
  await page.waitForTimeout(3000);
  const live = await chat.assistantText();
  expect((live.match(REASON) || []).length === 1, 'live: the reason is shown once');

  await page.reload();
  await chat.waitForAssistant(/Compaction failed: Not enough messages to compact\./, 30000);
  const reloaded = await chat.assistantText();
  expect((reloaded.match(REASON) || []).length === 1, 'after a reload: the reason is shown once');
}
