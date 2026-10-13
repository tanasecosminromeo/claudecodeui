// Session pins, status emoji and auto rename. The third completed turn of a
// chat gets an automatic title and status; a name the user set by hand is kept
// while the status still changes; "Auto rename" in the menu replaces even a
// manual name; the status picker pins a status and "Auto" hands it back; a pin
// lists the session first with a badge, survives a reload and unpins; on a phone
// the options sheet offers Pin to top, Auto rename and Set status.
const TIME_ZONE = 'Europe/Bucharest';
const PROMPTS = [
  "Let's fix a bug: the add(a,b) helper in math.js returns a-b. Don't edit files, just tell me the one-line fix.",
  'Explain why in one sentence.',
  "Thanks, that's it.",
];
const MANUAL_NAME = 'My manual name';

export const meta = {
  title: 'Pins, status emoji and auto rename: turn-3 title and status, a manual name kept, status picker, pin to top, phone sheet',
  timeoutMs: 900000,
};

/** Wall-clock time in Bucharest local time, for the screenshot captions. */
const clock = () => `${new Date().toLocaleTimeString('en-GB', { timeZone: TIME_ZONE, hour12: false })} EEST`;

export async function run({ chat, page, app, expect, snapshot, log }) {
  const started = Date.now();
  const snap = (label) => snapshot(`${label} at ${clock()}`);
  const api = async (method, url, body) => {
    const response = await fetch(`${app.base}${url}`, {
      method,
      headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`${method} ${url} answered ${response.status}: ${JSON.stringify(json)}`);
    }
    return json;
  };
  const projectId = app.project.projectId ?? app.project.name;
  expect(Boolean(projectId), `the test project has an id for the API (${projectId})`);
  const listSessions = async () => (await api('GET', `/api/projects/${encodeURIComponent(projectId)}/sessions?limit=50`)).sessions ?? [];
  const sessionById = async (id) => (await listSessions()).find((session) => session.id === id);
  /** Polls until check() reports ok, or gives up after timeoutMs and returns the last result. */
  const until = async (check, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let last = await check();
    while (!last.ok && Date.now() < deadline) {
      await page.waitForTimeout(1000);
      last = await check();
    }
    return last;
  };

  // Sidebar helpers. A desktop row is a link to its session; a phone row has no href.
  const row = (id) => page.locator(`a[href="/session/${id}"]`);
  const titleOf = async (id) => row(id).locator('div[title]').first().getAttribute('title');
  const statusLabelOf = async (id) => {
    const element = row(id).locator('[aria-label^="Status:"]');
    return (await element.count()) ? element.first().getAttribute('aria-label') : null;
  };
  const badgeCount = async (id) => row(id).locator('[aria-label="Pinned"]').count();
  /** Session ids in the order the sidebar draws them, keeping only the given ids. */
  const domOrder = async (ids) => {
    const hrefs = await page.locator('a[href^="/session/"]').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
    const order = [...new Set(hrefs.map((href) => href.split('/').pop()))];
    return order.filter((id) => ids.includes(id));
  };
  /** A desktop row's options button sits beside its link, in the same box. */
  const optionsButton = (id) => row(id).locator('xpath=..').getByRole('button', { name: /^Session options for/ });
  /**
   * The project's rows sit under its button. After a reload the project may
   * already be open, so wait for its list to show (its New Session button or a
   * row) and click the button only when the project is really folded.
   */
  const ensureRows = async (ids) => {
    const first = row(ids[0]);
    const newSession = page.getByRole('button', { name: 'New Session', exact: true });
    await until(async () => ({ ok: (await first.count()) > 0 || (await newSession.count()) > 0 }), 15000);
    if ((await first.count()) === 0 && (await newSession.count()) === 0) {
      await page.getByRole('button', { name: /^e2e-project/ }).first().click();
    }
    await first.waitFor({ timeout: 20000 });
  };
  /** The first match that is on screen: the sidebar keeps a closed copy off-screen on a phone. */
  const visibleOf = async (locator) => {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible().catch(() => false)) {
        return locator.nth(index);
      }
    }
    return locator.first();
  };
  const sendAndWait = async (text) => {
    const before = await chat.assistantMessageCount();
    await chat.send(text);
    await chat.waitForNewAssistant(/\S/, before, 120000);
    await chat.waitIdle(120000);
  };
  const firstWords = PROMPTS[0].split(/\s+/).slice(0, 4).join(' ');

  // A. Turn 3: automatic title and status for a session the user never named.
  await chat.openNewChat();
  await sendAndWait(PROMPTS[0]);
  const sessionA = await chat.sessionId();
  await row(sessionA).waitFor({ timeout: 20000 });
  const initialTitle = await titleOf(sessionA);
  log(`A: initial title "${initialTitle}"`);
  expect(initialTitle === firstWords, `A: after turn 1 the row shows the first four words of the prompt, "${firstWords}" (got "${initialTitle}")`);
  await sendAndWait(PROMPTS[1]);
  await sendAndWait(PROMPTS[2]);
  const turn3Done = Date.now();
  const autoA = await until(async () => {
    const title = await titleOf(sessionA);
    const label = await statusLabelOf(sessionA);
    return { ok: title !== initialTitle && Boolean(label), title, label };
  }, 120000);
  log(`A: after turn 3 ${((Date.now() - turn3Done) / 1000).toFixed(0)} s: title "${autoA.title}", status "${autoA.label}"`);
  expect(autoA.ok, `A: within 120 s after turn 3 the title changed from "${initialTitle}" and a status emoji appeared (title "${autoA.title}", status "${autoA.label}")`);
  const apiA = await sessionById(sessionA);
  expect(apiA?.summary === autoA.title, `A: the API has the same title (${apiA?.summary})`);
  expect(apiA?.status !== null && apiA?.status !== undefined, `A: the API has a status (${apiA?.status}, source ${apiA?.statusSource})`);
  // The open chat's header reads its own copy of the session, so it must follow too.
  const headerA = await until(async () => {
    const text = (await page.locator('h2.cursor-text').first().innerText().catch(() => '')).trim();
    return { ok: text === autoA.title, text };
  }, 10000);
  expect(headerA.ok, `A: the open chat's header shows the new title "${autoA.title}" (got "${headerA.text}")`);
  await snap('A desktop sidebar after turn 3 (automatic title and status)');

  // B. A manual name is kept by the automatic checks; the status still changes.
  await chat.openNewChat();
  await sendAndWait(PROMPTS[0]);
  const sessionB = await chat.sessionId();
  await row(sessionB).waitFor({ timeout: 20000 });
  const titleB1 = await titleOf(sessionB);
  await optionsButton(sessionB).click();
  await page.getByRole('menuitem', { name: 'Rename session', exact: true }).click();
  const renameInput = page.locator('input[type="text"]:focus');
  await renameInput.fill(MANUAL_NAME);
  await renameInput.press('Enter');
  const renamed = await until(async () => ({ ok: (await titleOf(sessionB)) === MANUAL_NAME, title: await titleOf(sessionB) }), 15000);
  expect(renamed.ok, `B: the manual rename shows "${MANUAL_NAME}" (got "${renamed.title}")`);
  expect((await sessionById(sessionB))?.nameSource === 'user', 'B: the server records the name as the user\'s');
  await sendAndWait(PROMPTS[1]);
  await sendAndWait(PROMPTS[2]);
  const autoB = await until(async () => {
    const label = await statusLabelOf(sessionB);
    return { ok: Boolean(label), label, title: await titleOf(sessionB) };
  }, 120000);
  log(`B: after turn 3: title "${autoB.title}", status "${autoB.label}"`);
  expect(autoB.ok, `B: within 120 s after turn 3 a status emoji appeared (status "${autoB.label}")`);
  expect(autoB.title === MANUAL_NAME, `B: the title is still exactly "${MANUAL_NAME}" after turn 3 (got "${autoB.title}")`);
  expect((await sessionById(sessionB))?.nameSource === 'user', 'B: the server still records the name as the user\'s');
  await snap('B desktop sidebar: manual name kept, status set');

  // C. "Auto rename" from the menu overrides the manual name on purpose.
  const beforeC = Date.now();
  await optionsButton(sessionB).click();
  await page.getByRole('menuitem', { name: /^Auto rename/ }).click();
  const renamedC = await until(async () => {
    const title = await titleOf(sessionB);
    return { ok: Boolean(title) && title !== MANUAL_NAME, title };
  }, 90000);
  log(`C: auto rename took ${((Date.now() - beforeC) / 1000).toFixed(0)} s, title now "${renamedC.title}"`);
  expect(renamedC.ok, `C: Auto rename changes "${MANUAL_NAME}" within 90 s (got "${renamedC.title}")`);
  await snap('C desktop sidebar after Auto rename on the manual-name session');

  // D. The status picker sets a status and hands it back to automatic checks.
  await row(sessionA).locator('[role="button"][aria-label^="Status:"], [role="button"][aria-label="Set status"]').first().click();
  const picker = page.getByRole('menu', { name: 'Set status', exact: true });
  await picker.waitFor({ timeout: 5000 });
  // Planning, because the automatic status of this chat is never planning,
  // so the emoji visibly changes.
  const autoStatusA = (await sessionById(sessionA))?.status;
  expect(autoStatusA !== 'planning', `D: the automatic status of A is not already planning (${autoStatusA})`);
  await picker.getByRole('menuitemradio', { name: 'Planning', exact: true }).click();
  const pickedLabel = await until(async () => {
    const label = await statusLabelOf(sessionA);
    return { ok: label === 'Status: Planning', label };
  }, 10000);
  expect(pickedLabel.ok, `D: the status emoji of A reads "Status: Planning" (got "${pickedLabel.label}")`);
  const emojiText = (await row(sessionA).locator('[aria-label="Status: Planning"]').innerText()).trim();
  expect(emojiText === '📝', `D: the Planning emoji is 📝 (got "${emojiText}")`);
  const apiPicked = await sessionById(sessionA);
  expect(apiPicked?.status === 'planning' && apiPicked?.statusSource === 'user', `D: the API stores status 'planning' from the user (${apiPicked?.status}, ${apiPicked?.statusSource})`);
  await snap('D desktop sidebar: status Planning set from the picker');

  await row(sessionA).locator('[aria-label="Status: Planning"]').first().click();
  await picker.waitFor({ timeout: 5000 });
  await picker.getByRole('menuitemradio', { name: 'Auto', exact: true }).click();
  const autoAgain = await until(async () => {
    const api = await sessionById(sessionA);
    return { ok: api?.statusSource !== 'user', api };
  }, 10000);
  expect(autoAgain.ok, `D: after Auto the API no longer marks the status as the user's (source ${autoAgain.api?.statusSource})`);
  expect(autoAgain.api?.status === 'planning', `D: Auto keeps the status in place until the next check ("${autoAgain.api?.status}")`);

  // E. Pin the older session: first in its project, badged, kept over a reload, unpinned.
  const ids = [sessionA, sessionB];
  const sessionsNow = await Promise.all(ids.map(sessionById));
  const [older, newer] = [...sessionsNow].sort((left, right) => String(left.lastActivity).localeCompare(String(right.lastActivity)));
  const olderId = older.id;
  const newerId = newer.id;
  log(`E: older session ${olderId === sessionA ? 'A' : 'B'} (${older.lastActivity}), newer ${newerId === sessionA ? 'A' : 'B'} (${newer.lastActivity})`);
  await ensureRows(ids);
  const olderTitle = await titleOf(olderId);
  await optionsButton(olderId).click();
  await page.getByRole('menuitem', { name: /^Pin to top/ }).click();
  const pinned = await until(async () => ({ ok: (await sessionById(olderId))?.pinned === true }), 15000);
  expect(pinned.ok, 'E: the API marks the older session as pinned');
  const orderPinned = await until(async () => {
    const order = await domOrder(ids);
    return { ok: order[0] === olderId, order };
  }, 10000);
  expect(orderPinned.ok, `E: the pinned session is the first row of its project (order: ${orderPinned.order.map((id) => (id === sessionA ? 'A' : 'B')).join(', ')})`);
  expect(await badgeCount(olderId) === 1 && await badgeCount(newerId) === 0, 'E: only the pinned session carries the "Pinned" badge');
  // Let the re-sorted list settle: right after the click it can still be mid-render.
  await page.waitForTimeout(1500);
  await snap('E desktop sidebar: older session pinned first with badge');

  await page.reload();
  await ensureRows(ids);
  const orderReloaded = await domOrder(ids);
  expect(orderReloaded[0] === olderId, 'E: after a reload the pinned session is still first');
  expect(await badgeCount(olderId) === 1, 'E: after a reload the pinned session still shows the badge');
  await snap('E after reload: still pinned first with badge');

  await optionsButton(olderId).click();
  await page.getByRole('menuitem', { name: /^Unpin/ }).click();
  const unpinned = await until(async () => ({ ok: (await sessionById(olderId))?.pinned === false }), 15000);
  expect(unpinned.ok, 'E: the API clears the pin');
  const byActivity = [olderId, newerId].sort((left, right) => {
    const at = (id) => String(sessionsNow.find((session) => session.id === id).lastActivity);
    return at(right).localeCompare(at(left));
  });
  const orderUnpinned = await until(async () => {
    const order = await domOrder(ids);
    return { ok: JSON.stringify(order) === JSON.stringify(byActivity), order };
  }, 10000);
  expect(orderUnpinned.ok, 'E: after Unpin the rows are back in activity order (newest first)');
  expect(await badgeCount(olderId) === 0, 'E: the badge is gone after Unpin');
  await snap('E desktop sidebar: unpinned, activity order again');

  // F. Phone: the options sheet, and the list with the badge and the status emoji.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const openMenu = page.getByRole('button', { name: 'Open menu', exact: true });
  if (await openMenu.isVisible().catch(() => false)) {
    await openMenu.click();
    await page.waitForTimeout(800); // the sidebar slides in
  }
  // A phone row is not a link, and two titles may match: the options button is
  // taken by its place among the rows on screen (newest first, the order E left).
  const phoneOptions = async () => {
    const all = page.getByRole('button', { name: `Session options for ${olderTitle}`, exact: true });
    const onScreen = [];
    for (let index = 0; index < await all.count(); index += 1) {
      if (await all.nth(index).isVisible().catch(() => false)) {
        onScreen.push(all.nth(index));
      }
    }
    return onScreen[byActivity.indexOf(olderId)] ?? all.first();
  };
  if (!(await (await phoneOptions()).isVisible().catch(() => false))) {
    await (await visibleOf(page.getByRole('button', { name: /^e2e-project/ }))).click();
  }
  await (await phoneOptions()).waitFor({ state: 'visible', timeout: 20000 });
  await (await phoneOptions()).click();
  const sheet = page.getByRole('dialog');
  await sheet.waitFor({ timeout: 5000 });
  expect(await sheet.getByRole('button', { name: 'Pin to top', exact: true }).isVisible(), 'F: the phone options sheet offers Pin to top');
  expect(await sheet.getByRole('button', { name: /^Auto rename/ }).isVisible(), 'F: the phone options sheet offers Auto rename');
  expect(await sheet.getByRole('button', { name: 'Set status', exact: true }).isVisible(), 'F: the phone options sheet offers Set status');
  await page.waitForTimeout(600); // the sheet slides up
  await snap('F phone options sheet with Pin to top, Auto rename and Set status');
  await sheet.getByRole('button', { name: 'Pin to top', exact: true }).click();
  const pinnedPhone = await until(async () => ({ ok: (await sessionById(olderId))?.pinned === true }), 15000);
  expect(pinnedPhone.ok, 'F: pinning from the phone sheet stores the pin');
  await sheet.waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
  // The sidebar stays open after Pin; open it again only if the badge is off-screen.
  const badgeBox = await page.locator('[aria-label="Pinned"]').first().boundingBox().catch(() => null);
  if (!badgeBox || badgeBox.x < 0 || badgeBox.x > 390) {
    await openMenu.click();
    await page.waitForTimeout(800);
  }
  const phoneBadge = await until(async () => {
    const count = await page.locator('[aria-label="Pinned"]').count();
    return { ok: count === 1, count };
  }, 10000);
  expect(phoneBadge.ok, `F: the phone list shows one Pinned badge (found ${phoneBadge.count})`);
  const phoneEmoji = page.locator('[role="img"][aria-label^="Status:"]');
  expect((await phoneEmoji.count()) > 0, 'F: the phone list shows a status emoji before a title');
  await snap('F phone project list: pinned session first with badge and status emoji');

  await page.setViewportSize({ width: 1400, height: 900 });
  log(`total ${((Date.now() - started) / 1000).toFixed(0)} s`);
}
