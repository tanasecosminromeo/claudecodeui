// A session that is blocked on the user (its last reply asked something) has no open card,
// but it still needs the user: the favicon pulses and the "Needs input" pill names it. The
// radar answer is faked in this browser only (page.route), so no status is written and the
// live service never sees it. Clearing the blocked list stops the pulse and hides the pill.
export const meta = {
  title: 'A blocked session with no card still pulses the favicon and shows in the Needs input pill, until cleared',
  timeoutMs: 120000,
};

const FAKE = {
  sessionId: 'e2e-fake-blocked-provider',
  appSessionId: 'e2e-fake-blocked-session',
  title: 'E2E fake blocked session that asked a question',
  project: 'e2e-project',
};

// The favicon <link>'s href over a short window, one entry per sample.
const sampleIcon = async (page, ms) => {
  const hrefs = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    hrefs.push(await page.evaluate(() => document.querySelector('link[rel~="icon"]')?.getAttribute('href') || ''));
    await page.waitForTimeout(200);
  }
  return hrefs;
};

export async function run({ chat, page, expect, snapshot }) {
  const fake = { blocked: [FAKE] };
  await page.route('**/api/plugins/*/rpc/sessions', async (route) => {
    const response = await route.fetch();
    const body = await response.json().catch(() => ({}));
    const sessions = (body.sessions || []).filter((s) => s.state !== 'waiting');
    await route.fulfill({ response, json: { ...body, sessions, blocked: fake.blocked } });
  });

  try {
    await chat.openNewChat();
    const pill = page.locator('#uic-alert');
    await pill.waitFor({ state: 'visible', timeout: 30000 });
    const text = (await pill.locator('.uic-alert-text').textContent())?.trim();
    expect(text === `Needs input: ${FAKE.title}`, `the pill names the blocked session (${text})`);
    expect(await pill.getAttribute('aria-label') === `Needs input: ${FAKE.title}`, 'the pill keeps its aria-label');

    // The pulse alternates between the lit and the dim frame: two distinct full hrefs, both data:.
    const hrefs = await sampleIcon(page, 2500);
    const distinct = [...new Set(hrefs)];
    expect(distinct.length === 2, `the favicon alternates between two frames (${distinct.length} distinct)`);
    expect(distinct.every((h) => h.startsWith('data:')), 'both favicon frames are generated pulse images');
    await snapshot('blocked session pulses, pill names it');

    // The list empties: the next poll (every 5 s) stops the pulse and hides the pill.
    fake.blocked = [];
    await pill.waitFor({ state: 'detached', timeout: 20000 });
    const after = await sampleIcon(page, 1500);
    expect(after.every((h) => !h.startsWith('data:')), 'the favicon is back to the page icon');
    expect(new Set(after).size === 1, 'the favicon no longer changes');
    await snapshot('blocked list cleared: pill gone, icon still');
  } finally {
    await page.unroute('**/api/plugins/*/rpc/sessions');
  }
}
