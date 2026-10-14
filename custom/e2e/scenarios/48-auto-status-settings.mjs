// Settings → Auto status: today's usage of the automatic checks is shown, a new
// daily limit survives a reload, and the phone layout fits 390 px wide. The
// scenario sends no message and starts no session, so no automatic model check
// can run; the limit is put back to 500 in `finally`.
export const meta = {
  title: 'Auto status: today usage shows in Settings, a changed daily limit survives a reload, and the tab fits a phone',
  timeoutMs: 150000,
};

export async function run({ chat, page, app, expect, snapshot, sleep }) {
  const api = async (method, url, body) => {
    const response = await fetch(`${app.base}${url}`, {
      method,
      headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  // The ui-cleanup "Leftover processes" dialog opens on its own when the host has
  // real leftovers and covers the page. Answer its list with nothing; never kill anything.
  await page.route('**/api/plugins/*/rpc/leftovers', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ groups: [], serverStartedAt: 0 }),
  }));
  const leftovers = page.locator('#uic-leftovers');
  if (await leftovers.isVisible().catch(() => false)) {
    await leftovers.getByRole('button', { name: 'Close', exact: true }).click();
  }
  const openAutoStatus = async () => {
    await page.locator('button:has(svg.lucide-settings)').filter({ visible: true }).first().click();
    await page.getByRole('button', { name: 'Auto status', exact: true }).filter({ visible: true }).first().click();
    await page.getByRole('heading', { name: 'Automatic checks', exact: true }).waitFor({ timeout: 10000 });
  };
  const dailyLimit = () => page.getByRole('spinbutton', { name: 'Daily limit' });

  try {
    await chat.openNewChat();

    const before = await api('GET', '/api/session-status-checks');
    expect(before.status === 200, `GET /api/session-status-checks answers 200 (${before.status})`);
    const { settings, stats } = before.body;
    expect(settings.enabled === true && settings.dailyLimit === 500, `the defaults are on with a daily limit of 500 (${JSON.stringify(settings)})`);

    await openAutoStatus();
    const usageLine = page.getByText(`${stats.today.used} / ${stats.today.limit} automatic checks`, { exact: true });
    await usageLine.waitFor({ timeout: 10000 });
    expect(await usageLine.isVisible(), `today shows ${stats.today.used} / ${stats.today.limit} automatic checks`);
    expect((await dailyLimit().inputValue()) === '500', 'the Daily limit field shows 500');

    await dailyLimit().fill('400');
    await dailyLimit().press('Enter');
    // Polled from the test side: the page's own requests carry the login token, a bare fetch here would not.
    const storedLimit = async () => (await api('GET', '/api/session-status-checks')).body?.settings?.dailyLimit;
    let stored = await storedLimit();
    for (let attempt = 0; attempt < 50 && stored !== 400; attempt += 1) {
      await sleep(200);
      stored = await storedLimit();
    }
    expect(stored === 400, `the server stores the daily limit of 400 (${stored})`);

    // A fresh load: the value is read back from the server, not from the page.
    await page.reload();
    await chat.openNewChat();
    await openAutoStatus();
    await dailyLimit().waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('input[aria-label="Daily limit"]')?.value === '400', null, { timeout: 10000 });
    expect((await dailyLimit().inputValue()) === '400', 'after a reload the Daily limit field still shows 400');
    await snapshot('desktop: Auto status with today usage and the daily limit of 400');

    // Phone: close the dialog, then open Settings → Auto status the way a phone user does.
    await page.keyboard.press('Escape');
    await dailyLimit().waitFor({ state: 'detached', timeout: 10000 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(800);
    const openMenu = page.getByRole('button', { name: 'Open menu', exact: true });
    if (await openMenu.isVisible().catch(() => false)) {
      await openMenu.click();
      await page.waitForTimeout(800);
    }
    await page.locator('button:has(svg.lucide-settings)').filter({ visible: true }).first().click();
    await page.getByRole('button', { name: 'Auto status', exact: true }).filter({ visible: true }).first().click();
    await dailyLimit().waitFor({ timeout: 10000 });
    await page.getByRole('table').scrollIntoViewIfNeeded();
    const pageWidth = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth }));
    expect(pageWidth.scroll <= pageWidth.inner, `the phone page does not scroll sideways (${JSON.stringify(pageWidth)})`);
    await snapshot('phone: Auto status at 390 px');
  } finally {
    await page.setViewportSize({ width: 1400, height: 900 });
    await api('PUT', '/api/session-status-checks/settings', { dailyLimit: 500 });
  }
}
