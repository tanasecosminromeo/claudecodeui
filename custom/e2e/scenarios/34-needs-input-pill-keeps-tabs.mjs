// The "Needs input" pill (ui-cleanup) sits in the workspace header next to the
// tabs, never on top of them: with a session waiting, every tab stays clickable,
// on a desktop window and on a phone. The waiting session is faked in this
// browser's copy of the Session Radar answer only, so no status file is written
// and the live service never sees it (no push notification).
export const meta = {
  title: 'The Needs input pill sits beside the workspace tabs, never over them',
  timeoutMs: 120000,
};

const FAKE = {
  sessionId: 'e2e-fake-waiting-session',
  state: 'waiting',
  title: 'E2E fake session waiting for a very long approval title',
  project: 'e2e-project',
};

export async function run({ chat, page, expect, snapshot }) {
  await page.route('**/api/plugins/*/rpc/sessions', async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    const sessions = (body.sessions || []).filter((s) => s.state !== 'waiting');
    await route.fulfill({ response, json: { ...body, sessions: [...sessions, FAKE] } });
  });

  try {
    await chat.openNewChat();
    const tablist = page.getByRole('tablist', { name: 'Workspace views' });
    await tablist.waitFor({ timeout: 15000 });
    const pill = page.locator('#uic-alert');
    await pill.waitFor({ state: 'visible', timeout: 30000 });

    // Every visible tab answers a click at its own centre, and the pill is beside them.
    // On a desktop every tab must be in view; a phone's strip scrolls by design,
    // so there only the tabs in view must take a click.
    const check = (allInView) => page.evaluate((allInView) => {
      const tablist = document.querySelector('[role="tablist"][aria-label="Workspace views"]');
      const tabs = [...tablist.querySelectorAll('[role="tab"]')].filter((tab) => tab.offsetParent !== null);
      const covered = tabs.filter((tab) => {
        const r = tab.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (hit && tab.contains(hit)) return false;
        return allInView || !!hit?.closest('#uic-alert');
      }).map((tab) => tab.getAttribute('aria-label'));
      const pill = document.getElementById('uic-alert');
      const pr = pill.getBoundingClientRect();
      return {
        tabs: tabs.map((tab) => tab.getAttribute('aria-label')),
        covered,
        inHeader: !!pill.closest('header'),
        pillVisible: pr.width > 0 && pr.height > 0 && pr.right <= innerWidth + 1,
        compact: pill.classList.contains('uic-alert-compact'),
        label: pill.getAttribute('aria-label'),
      };
    }, allInView);

    const wide = await check(true);
    expect(wide.inHeader && wide.pillVisible, 'desktop: the pill is in the header and visible');
    expect(wide.covered.length === 0, `desktop: every tab is in view and takes a click (${wide.covered.length ? 'not: ' + wide.covered.join(', ') : wide.tabs.join(', ')})`);
    expect(!wide.compact, 'desktop: the pill shows its text');
    await snapshot('desktop header with the pill');
    await tablist.getByRole('tab', { name: 'Files', exact: true }).click({ timeout: 5000 });
    expect(true, 'desktop: the Files tab takes a click');
    await tablist.getByRole('tab', { name: 'Chat', exact: true }).click({ timeout: 5000 });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.getElementById('uic-alert')?.classList.contains('uic-alert-compact'), null, { timeout: 10000 });
    await page.waitForTimeout(800); // the sidebar slides shut when the window gets phone-sized
    const phone = await check(false);
    expect(phone.pillVisible, 'phone: the pill is visible');
    expect(phone.covered.length === 0, `phone: the pill covers no tab (${phone.covered.length ? 'covers: ' + phone.covered.join(', ') : phone.tabs.join(', ')})`);
    expect(phone.compact && phone.label === `Needs input: ${FAKE.title}`, 'phone: compact pill, the title stays in its label');
    await snapshot('phone header with the compact pill');
  } finally {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.unroute('**/api/plugins/*/rpc/sessions');
  }
}
