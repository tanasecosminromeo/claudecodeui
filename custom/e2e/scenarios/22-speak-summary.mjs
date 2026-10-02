// Hovering the speaker on a reply offers "Summarised"; picking it shows the
// summary the local speech stack reads long replies as (Gemma via llama.cpp's
// tts service), shorter than the reply, with its own read-aloud button.
// Needs VOICE_API_BASE_URL in this checkout's .env and the llama.cpp `tts`,
// `stt` and `llama-cpp` services up.
export const meta = {
  title: 'Hovering the speaker offers "Summarised", which shows a summary',
  timeoutMs: 180000,
};

export async function run({ chat, page, app, expect, snapshot, log }) {
  const saved = await fetch(`${app.base}/api/user/preferences`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${app.token}` },
    body: JSON.stringify({ uiPreferences: { voiceEnabled: true } }),
  });
  expect(saved.ok, `voice turned on in preferences (${saved.status})`);

  await chat.openNewChat();
  await chat.send('In about eight plain sentences, explain how bicycle gears work. No lists, no headings.');
  await chat.waitForAssistant(/gear/i, 90000);
  await chat.waitIdle(60000);
  const reply = (await page.locator('.chat-message.assistant').last().locator('.prose').first().innerText()).trim();
  log(`reply: ${reply.length} chars`);

  const speak = page.locator('.chat-message.assistant').last().getByRole('button', { name: 'Read aloud' });
  await speak.hover();
  const item = page.getByRole('menuitem', { name: 'Summarised' });
  await item.waitFor({ timeout: 5000 });
  expect(true, 'hovering the speaker shows "Summarised"');
  await item.click();

  const popover = page.getByTestId('speech-summary');
  await popover.waitFor({ timeout: 10000 });
  await page.waitForFunction(
    () => !document.querySelector('[data-testid="speech-summary"]')?.textContent?.includes('Summarising'),
    null,
    { timeout: 120000 },
  );
  const text = (await popover.innerText()).replace(/^Summary\s*/i, '').trim();
  log(`summary: "${text}"`);
  await snapshot('the summary under the speaker');
  expect(
    text.length >= 40 && text.length <= reply.length * 0.6,
    `a summary well under the reply's length (${text.length} vs ${reply.length} chars)`,
  );
  expect(!/cannot summarise|failed/i.test(text), 'no error in the popover');
  expect(await popover.getByRole('button', { name: 'Read the summary aloud' }).isVisible(), 'the summary has its own read-aloud button');

  await popover.getByRole('button', { name: 'Close summary' }).click();
  expect(await popover.count() === 0, 'Close removes the popover');
}
