// The header usage meter drops its 7d figure when the sidebar header is too
// narrow for it, instead of overlapping the neighbouring buttons.
export const meta = {
  title: 'Usage meter shrinks to 5h when space is tight',
  timeoutMs: 90000,
};

export async function run({ chat, page, expect, snapshot }) {
  await chat.openNewChat();
  const meter = page.locator('[data-uic-usage="header"]').first();
  await meter.waitFor({ state: 'attached', timeout: 15000 });
  // Force a known state: full text, then squeeze the row.
  await page.evaluate(() => {
    const m = document.querySelector('[data-uic-usage="header"]');
    m.replaceChildren('5h 12%', Object.assign(document.createElement('span'), { className: 'uic-usage-7d', textContent: ' · 7d 34%' }));
    m.parentElement.parentElement.style.width = '120px';
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => document.querySelector('[data-uic-usage="header"]')?.dataset.compact === '1', null, { timeout: 5000 });
  const hidden = await meter.locator('.uic-usage-7d').evaluate((el) => getComputedStyle(el).display === 'none');
  expect(hidden, 'the 7d figure is hidden when compact');
  await snapshot('compact usage meter');
}
