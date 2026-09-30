import fs from 'node:fs';
import path from 'node:path';

// /btw on an idle session (no live process): a throwaway fork answers. It
// reads the conversation but writes no transcript of its own and leaves no
// process behind.
export const meta = {
  title: '/btw on an idle session answers from a throwaway fork, no transcript, no process',
  timeoutMs: 120000,
};

const transcripts = (paths) => {
  const dir = path.join(process.env.HOME, '.claude', 'projects', paths.project.replace(/[^A-Za-z0-9]/g, '-'));
  return fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl')).sort();
};

export async function run({ chat, page, paths, expect, sleep, processes }) {
  await chat.openNewChat();
  // Haiku occasionally balks at a tiny opening message in a brand-new session
  // ("I don't see an actual task"); a second try in the same session is
  // obeyed. The scenario is about /btw, not about the model's first mood.
  await chat.send('Reply with the single word PINEAPPLE and nothing else.');
  const sessionId = await chat.sessionId();
  await chat.waitForAssistant(/./, 60000);
  await chat.waitIdle(60000);
  if (!/PINEAPPLE/.test(await chat.assistantText())) {
    await chat.send('Please reply with the single word PINEAPPLE and nothing else.');
    await chat.waitForAssistant(/PINEAPPLE/, 60000);
    await chat.waitIdle(60000);
  }
  for (let i = 0; i < 15 && processes(sessionId).length > 0; i++) {
    await sleep(1000);
  }
  expect(processes(sessionId).length === 0, 'no live process for the session');
  const before = transcripts(paths);

  await chat.send('/btw Which single word did I ask you to reply with? Answer with just that word.');
  const popup = page.locator('[role=dialog]').filter({ hasText: /PINEAPPLE/ });
  await popup.waitFor({ state: 'visible', timeout: 60000 });
  expect(true, 'the fork answered from the conversation');
  await page.keyboard.press('Escape');
  await sleep(2000);
  expect(transcripts(paths).length === before.length, 'the fork wrote no transcript of its own');
  expect(processes(sessionId).length === 0, 'and left no process behind');
}
