// The "Other..." answer box of an AskUserQuestion card wraps a long answer onto
// more lines instead of scrolling it sideways (which hid its start behind the
// left edge and its end under the "Enter" hint), on a desktop and a phone width.
// Enter still submits; the answer reaches Claude in full.
export const meta = {
  title: 'A long "Other" answer in a question card wraps and grows',
  timeoutMs: 180000,
  mode: 'default',
};

const ANSWER = 'Build it, but beware there is another session that may work on calendar settings. '
  + 'Perhaps wait until that one finishes its work before touching the shared files. MARKER-END';

export async function run({ chat, page, expect, snapshot }) {
  await chat.openNewChat();
  await chat.send('Use the AskUserQuestion tool once to ask me "Proceed?" with the options "Yes" and "No". '
    + 'After I answer, reply with ANSWER: followed by my answer, word for word.');

  await page.getByRole('button', { name: /Other\.\.\./ }).waitFor({ state: 'visible', timeout: 90000 });
  await page.getByRole('button', { name: /Other\.\.\./ }).click();
  const box = page.getByPlaceholder('Type your answer...');
  await box.waitFor({ state: 'visible', timeout: 5000 });
  const singleLine = await box.evaluate((el) => el.getBoundingClientRect().height);
  await box.pressSequentially(ANSWER, { delay: 2 });

  const measure = () => box.evaluate((el) => ({
    tag: el.tagName,
    height: el.getBoundingClientRect().height,
    scrollLeft: el.scrollLeft,
    overflowsSideways: el.scrollWidth > el.clientWidth + 1,
    overflowsDown: el.scrollHeight > el.clientHeight + 1,
    bottomInView: (() => {
      const list = el.closest('[role=radiogroup],[role=group]');
      return !list || el.getBoundingClientRect().bottom + 2 <= list.getBoundingClientRect().bottom; // + the 2 px focus ring
    })(),
  }));
  const desktop = await measure();
  expect(desktop.tag === 'TEXTAREA', `the answer box is a textarea (got ${desktop.tag})`);
  expect(desktop.height > singleLine * 1.5, `the box grew with the text (${singleLine}px → ${desktop.height}px)`);
  expect(!desktop.overflowsSideways && desktop.scrollLeft === 0, 'no sideways scroll: the start of the answer stays visible');
  expect(!desktop.overflowsDown, 'the whole answer is visible without scrolling inside the box');
  expect(desktop.bottomInView, 'the box is not cut off at the bottom of the options list');
  await snapshot('desktop: the long answer wraps');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await box.press('End');
  const phone = await measure();
  expect(!phone.overflowsSideways && phone.scrollLeft === 0, 'phone width: still no sideways scroll');
  expect(phone.height > desktop.height, `phone width: more lines, taller box (${desktop.height}px → ${phone.height}px)`);
  expect(phone.bottomInView, 'phone width: the box is not cut off at the bottom of the options list');
  await snapshot('phone: the long answer wraps');

  await box.press('Enter');
  await chat.waitForAssistant(/ANSWER:[\s\S]*MARKER-END/, 90000);
  expect(true, 'Enter submitted and Claude got the full answer');
}
