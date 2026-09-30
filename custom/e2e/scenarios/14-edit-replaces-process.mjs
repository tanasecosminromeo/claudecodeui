// Editing an already-sent message rewinds the conversation, which a live
// process cannot do: the edit replaces the process (its background work goes
// with it), and the replacement answers on the rewound conversation.
//
// The edited message is the second one, not the first: editing the very first
// prompt makes the CLI start a new session file that the app does not follow
// (an upstream gap, unrelated to process replacement). The rewind is checked
// on disk — the edited prompt branches off the reply before it, so the
// replaced turn is no longer an ancestor — not in the rendered chat: the
// history reader only hides an abandoned branch when the two prompts share a
// parent row, which they do not here (another upstream gap).
export const meta = {
  title: 'Editing a sent message while the process is held replaces the process',
  timeoutMs: 180000,
};

import fs from 'node:fs';
import path from 'node:path';

/** Rows of the session's transcript, keyed by uuid. */
function transcriptRows(paths, providerSessionId) {
  const dir = path.join(process.env.HOME, '.claude', 'projects', paths.project.replace(/[^A-Za-z0-9]/g, '-'));
  const rows = fs.readFileSync(path.join(dir, `${providerSessionId}.jsonl`), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return new Map(rows.filter((row) => row.uuid).map((row) => [row.uuid, row]));
}

const promptText = (row) => (typeof row?.message?.content === 'string' ? row.message.content : (row?.message?.content ?? []).map((part) => part.text ?? '').join(''));

export async function run({ chat, page, expect, sleep, processes, paths }) {
  await chat.openNewChat();
  await chat.send('Reply with the single word FIRST.');
  const sessionId = await chat.sessionId();
  await chat.waitForAssistant(/FIRST/, 60000);
  await chat.waitIdle(30000);
  await chat.send('Use the Bash tool with run_in_background=true to run exactly `sleep 90; echo BGDONE`. Do not wait for it. Reply STARTED only.');
  await chat.waitForAssistant(/STARTED/, 60000);
  await chat.waitIdle(30000);
  const [held] = processes(sessionId);
  expect(Boolean(held), `the process is held for the background command (pid ${held?.pid})`);

  const heldTurn = page.locator('.chat-message').filter({ hasText: 'run_in_background=true' }).first();
  await heldTurn.hover();
  await heldTurn.getByRole('button', { name: 'Edit and resend' }).click();
  await chat.composer().fill('Reply with the single word EDITED.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await chat.waitForAssistant(/EDITED/, 90000);
  await chat.waitIdle(30000);

  let oldGone = false;
  for (let i = 0; i < 20 && !oldGone; i++) {
    await sleep(500);
    oldGone = !processes(sessionId).some((record) => record.pid === held.pid);
  }
  expect(oldGone, 'the held process was replaced');
  // On disk: the edited prompt continues from the FIRST reply; the replaced
  // turn is not in its ancestry.
  const rows = transcriptRows(paths, held.providerSessionId);
  const edited = [...rows.values()].find((row) => row.type === 'user' && promptText(row).includes('single word EDITED'));
  expect(Boolean(edited), 'the edited prompt is in the transcript');
  const ancestry = [];
  for (let row = rows.get(edited.parentUuid); row; row = rows.get(row.parentUuid)) {
    ancestry.push(promptText(row));
  }
  expect(ancestry.some((text) => text.includes('FIRST')), `it continues from the FIRST reply (ancestry: ${JSON.stringify(ancestry.slice(0, 4))})`);
  expect(!ancestry.some((text) => text.includes('run_in_background')), 'the replaced turn is no longer part of the conversation');
}
