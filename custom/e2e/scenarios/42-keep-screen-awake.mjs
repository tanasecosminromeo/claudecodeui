// The "Keep screen awake" switch in Quick Settings holds one screen wake lock
// while it is on, keeps it across a reload (the switch is per device, in
// localStorage), and releases it when the switch goes off. The browser has no
// wake lock in the test, so a fake navigator.wakeLock counts requests and
// releases on window.__wl.
export const meta = {
  title: 'Keep screen awake: the Quick Settings switch holds one screen wake lock, across a reload, until it is switched off',
  timeoutMs: 120000,
};

const FAKE_WAKE_LOCK = () => {
  const counts = { requests: 0, releases: 0, active: 0 };
  window.__wl = counts;
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      request: async (type) => {
        counts.requests += 1;
        counts.active += 1;
        const sentinel = {
          type,
          released: false,
          addEventListener() {},
          release: async () => {
            if (!sentinel.released) {
              sentinel.released = true;
              counts.releases += 1;
              counts.active -= 1;
            }
          },
        };
        return sentinel;
      },
    },
  });
};

export async function run({ chat, page, expect, snapshot }) {
  await page.addInitScript(FAKE_WAKE_LOCK);

  // A reload lands on the project list; reopening the new chat puts the composer back.
  const reload = async () => {
    await page.reload();
    await chat.openNewChat();
  };

  await chat.openNewChat();
  await page.evaluate(() => window.localStorage.removeItem('keepScreenAwake'));
  await reload();

  const openDrawer = async () => {
    const handle = page.getByRole('button', { name: 'Open settings panel', exact: true });
    if (await handle.count() > 0) {
      await handle.first().click();
    }
    await page.getByTestId('keep-screen-awake-toggle').waitFor({ timeout: 10000 });
  };

  await openDrawer();
  const toggle = page.getByTestId('keep-screen-awake-toggle');
  expect(await toggle.isVisible(), 'the "Keep screen awake" switch is shown in Input settings');
  expect(!(await toggle.isChecked()), 'the switch is off by default');
  expect(await page.evaluate(() => window.__wl.active) === 0, 'no wake lock is held while the switch is off');

  await toggle.click();
  await page.waitForFunction(() => window.__wl.active === 1, null, { timeout: 10000 });
  expect(await toggle.isChecked(), 'the switch is on after the click');
  const onCounts = await page.evaluate(() => ({ ...window.__wl }));
  expect(onCounts.requests === 1 && onCounts.active === 1, `one screen lock is held (${JSON.stringify(onCounts)})`);
  await snapshot('quick settings with Keep screen awake on');

  await reload();
  await page.waitForFunction(() => window.__wl.active === 1, null, { timeout: 15000 });
  const afterReload = await page.evaluate(() => ({ ...window.__wl }));
  expect(afterReload.requests === 1, `after a reload the lock is requested again (${JSON.stringify(afterReload)})`);

  await openDrawer();
  expect(await page.getByTestId('keep-screen-awake-toggle').isChecked(), 'the switch is still on after a reload');

  await page.getByTestId('keep-screen-awake-toggle').click();
  await page.waitForFunction(() => window.__wl.active === 0, null, { timeout: 10000 });
  const offCounts = await page.evaluate(() => ({ ...window.__wl }));
  expect(offCounts.releases >= 1 && offCounts.active === 0, `switching off releases the lock (${JSON.stringify(offCounts)})`);
  expect(!(await page.getByTestId('keep-screen-awake-toggle').isChecked()), 'the switch is off again');
}
