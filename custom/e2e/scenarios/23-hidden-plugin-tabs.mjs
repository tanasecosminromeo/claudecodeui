// The Usage and Sessions plugin tabs are hidden from the workspace tab bar
// (ui-cleanup): Usage is the header meter, Sessions the sidebar Running view.
// The plugins themselves stay enabled, since both of those call their servers;
// arrow keys in the tab bar must skip the hidden tabs too.
export const meta = {
  title: 'Usage and Sessions are not in the workspace tab bar',
  timeoutMs: 90000,
};

export async function run({ chat, page, app, expect, snapshot }) {
  await chat.openNewChat();
  const tablist = page.getByRole('tablist', { name: 'Workspace views' });
  await tablist.waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-label="Usage"]')?.disabled === true, null, { timeout: 10000 });

  const visible = await tablist.locator('[role="tab"]').evaluateAll((tabs) => tabs
    .filter((tab) => tab.offsetParent !== null)
    .map((tab) => tab.getAttribute('aria-label')));
  expect(!visible.includes('Usage') && !visible.includes('Sessions'), `visible tabs: ${visible.join(', ')}`);
  expect(visible.includes('Chat') && visible.includes('Shell'), 'the built-in tabs are still there');
  await snapshot('workspace tab bar');

  // Arrow keys walk the tabs with .click(): from the tab before Usage, the
  // next stop must not be a hidden one.
  const before = await tablist.locator('[role="tab"]').evaluateAll((tabs) => {
    const index = tabs.findIndex((tab) => tab.getAttribute('aria-label') === 'Usage');
    return index > 0 ? tabs[index - 1].getAttribute('aria-label') : null;
  });
  if (before) {
    await tablist.getByRole('tab', { name: before, exact: true }).click();
    await page.keyboard.press('ArrowRight');
    const selected = await tablist.locator('[role="tab"][aria-selected="true"]').getAttribute('aria-label');
    expect(selected !== 'Usage' && selected !== 'Sessions', `ArrowRight from ${before} lands on ${selected}, not a hidden tab`);
  }

  const plugins = await fetch(`${app.base}/api/plugins`, { headers: { Authorization: `Bearer ${app.token}` } })
    .then((response) => response.json());
  const list = Array.isArray(plugins) ? plugins : plugins.plugins || [];
  const enabled = (name) => list.find((plugin) => plugin.name === name)?.enabled !== false;
  expect(enabled('claude-usage') && enabled('session-radar'), 'both plugins are still enabled (the meter and Running view use them)');
}
