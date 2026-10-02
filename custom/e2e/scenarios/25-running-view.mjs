// The Running view lists every live Claude process of this user with a
// summary line and per-row facts, and keeps ended sessions collapsed until
// asked for. Hovering a session row hides its age so it never sits next to
// the archive icon and the options menu.
export const meta = {
  title: 'Running view: live sessions with memory, ended group collapsed; row age hides on hover',
  timeoutMs: 120000,
};

export async function run({ chat, page, expect, snapshot }) {
  await chat.openNewChat();
  await chat.send('Reply with the single word PINEAPPLE and nothing else.');
  const sessionId = await chat.sessionId();
  await chat.waitForAssistant(/./, 60000);
  await chat.waitIdle(60000);

  // Age of a row: hidden while hovered.
  const row = page.locator(`a[href="/session/${sessionId}"]`).first();
  await row.waitFor({ state: 'visible', timeout: 20000 });
  await page.mouse.move(0, 0);
  await row.hover();
  const ageOpacity = await row.evaluate((a) => {
    const spans = [...a.querySelectorAll('span')].filter((s) => /^\d+[mhd]$|^now$/.test(s.textContent.trim()));
    return spans.length ? Math.min(...spans.map((s) => Number(getComputedStyle(s).opacity))) : null;
  });
  expect(ageOpacity === null || ageOpacity < 0.05, `the row age is hidden on hover (opacity ${ageOpacity})`);
  await snapshot('hovered session row');

  await page.locator('button:has(svg.lucide-activity)').first().click();
  const panel = page.locator('[data-uic-radar]');
  await panel.waitFor({ timeout: 15000 });
  await panel.locator('.sr-summary').waitFor({ timeout: 15000 });
  const summary = await panel.locator('.sr-summary').innerText();
  expect(/\d/.test(summary) && /(MB|GB)/.test(summary), `one summary line with icons: ${summary}`);
  expect(await panel.locator('.sr-summary').count() === 1 && await panel.locator('.sr-summary svg').count() >= 3, 'the stats are one line of icons');
  const live = panel.locator('.sr-row:not(.sr-ended)');
  expect(await live.count() >= 1, 'at least the test session is listed as live');
  expect(/(MB|GB)/.test(await live.first().locator('.sr-meta').innerText()), 'a live row shows its memory');

  const toggle = panel.locator('.sr-toggle');
  if (await toggle.count()) {
    expect(await panel.locator('.sr-row.sr-ended').count() === 0, 'ended sessions are collapsed by default');
    await toggle.click();
    await page.waitForFunction(() => document.querySelector('[data-uic-radar] .sr-row.sr-ended'), null, { timeout: 5000 });
  }
  await snapshot('running view');
  await page.evaluate(() => localStorage.removeItem('session-radar-ended-open'));
}
