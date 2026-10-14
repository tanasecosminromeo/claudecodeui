// Quick archive with Undo: one click on the sidebar row's archive icon (or
// the header's, for the open session) archives the session on the server,
// closes it, drops it from the list and shows an "Archived …" notice. Undo
// restores it through the server, puts it back in the list and reopens it.
export const meta = {
  title: 'Quick archive shows an Undo notice; Undo brings the session back to the list and reopens it',
  timeoutMs: 150000,
};

export async function run({ chat, page, expect, snapshot }) {
  await chat.openNewChat();
  await chat.send('Reply with the single word PINEAPPLE and nothing else.');
  const sessionId = await chat.sessionId();
  await chat.waitForAssistant(/./, 60000);
  await chat.waitIdle(60000);

  const sessionRow = () => page.locator(`a[href="/session/${sessionId}"]`).first();
  const notice = page.getByTestId('quick-archive-notice');
  const noSessionInUrl = (url) => !url.pathname.includes('/session/');

  // From the sidebar row, at rest: the archive icon shows without any hover.
  await sessionRow().waitFor({ state: 'visible', timeout: 20000 });
  await page.mouse.move(0, 0);
  const desktopArchive = sessionRow().locator('..').getByRole('button', { name: /^Archive session/ });
  expect((await desktopArchive.evaluate((el) => getComputedStyle(el).opacity)) === '1', 'desktop: the archive icon is visible at rest, without hover');
  await snapshot('desktop row at rest: title, age, archive icon and options');
  await desktopArchive.click();
  await notice.first().waitFor({ state: 'visible', timeout: 10000 });
  expect(/Archived/.test(await notice.first().innerText()), 'the notice says the session was archived');
  await snapshot('the Undo notice after archiving from the sidebar row');
  await page.waitForURL(noSessionInUrl, { timeout: 10000 });
  await page.waitForFunction((href) => !document.querySelector(`a[href="${href}"]`), `/session/${sessionId}`, { timeout: 10000 });
  expect(true, 'the open session was closed and its row left the sidebar');

  await notice.first().getByRole('button', { name: 'Undo' }).click();
  await sessionRow().waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForURL(new RegExp(`/session/${sessionId}$`), { timeout: 10000 });
  await notice.waitFor({ state: 'hidden', timeout: 5000 });
  await chat.waitForAssistant(/PINEAPPLE/, 30000);
  expect(true, 'Undo put the session back in the list, reopened it with its reply, and the notice is gone');
  await snapshot('after Undo: the session is back and open again');

  // From the chat header, for the open session (the one-tap path on phones).
  await page.getByRole('button', { name: `Archive session: ${await sessionRow().innerText().then((text) => text.split('\n')[0].trim())}` }).first().click();
  await notice.first().waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForURL(noSessionInUrl, { timeout: 10000 });
  expect(true, 'the header button archived the open session and showed the notice');
  await snapshot('the Undo notice after archiving from the header');

  await notice.first().getByRole('button', { name: 'Undo' }).click();
  await sessionRow().waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForURL(new RegExp(`/session/${sessionId}$`), { timeout: 10000 });
  expect(true, 'Undo from the header archive also restored and reopened the session');

  // Phone: a second session, archived from its compact row without any hover.
  await chat.openNewChat();
  await chat.send('Reply with the single word MANGO and nothing else.');
  const secondId = await chat.sessionId();
  await chat.waitForAssistant(/MANGO/, 60000);
  await chat.waitIdle(60000);
  const secondRow = () => page.locator(`a[href="/session/${secondId}"]`).first();
  await secondRow().waitFor({ state: 'visible', timeout: 20000 });
  const secondName = (await secondRow().innerText()).split('\n')[0].trim();
  await chat.openNewChat();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  const openMenu = page.getByRole('button', { name: 'Open menu', exact: true });
  if (await openMenu.isVisible().catch(() => false)) {
    await openMenu.click();
    await page.waitForTimeout(800);
  }
  const phoneArchive = page.getByRole('button', { name: `Archive session: ${secondName}`, exact: true }).first();
  await phoneArchive.waitFor({ state: 'visible', timeout: 20000 });
  const box = await phoneArchive.boundingBox();
  expect(box && box.width >= 32 && box.height >= 32, `phone: the archive button is a touch target of at least 32 px (${JSON.stringify(box)})`);
  expect((await phoneArchive.evaluate((el) => getComputedStyle(el).opacity)) === '1', 'phone: the archive button is visible at rest, without hover');
  await snapshot('phone row at rest: title, age, archive icon and options');
  await phoneArchive.click();
  await notice.first().waitFor({ state: 'visible', timeout: 10000 });
  expect(/Archived/.test(await notice.first().innerText()), 'phone: the notice says the session was archived');
  await snapshot('phone: the Undo notice after archiving from the compact row');

  await notice.first().getByRole('button', { name: 'Undo' }).click();
  await notice.waitFor({ state: 'hidden', timeout: 5000 });
  await page.getByRole('button', { name: `Archive session: ${secondName}`, exact: true }).first().waitFor({ state: 'visible', timeout: 20000 });
  expect(true, 'phone: Undo put the compact row back in the list');
  await page.setViewportSize({ width: 1400, height: 900 });
}
