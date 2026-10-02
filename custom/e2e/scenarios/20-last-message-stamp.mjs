// The transcript ends with when the last message was sent: a full local
// timestamp and "X ago", right-aligned and italic on the last reply's
// copy/speak row. The "ago" holds still until the last message changes or the
// page is reloaded. Hidden while a turn runs.
export const meta = {
  title: 'The chat ends with the last message time and an "ago" that holds still',
  timeoutMs: 120000,
};

const STAMP = /^last message \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · ((\d+d )?(\d+h )?(\d+m )?\d+s) ago$/;

const seconds = (ago) => ago.split(' ').reduce((total, part) => {
  const value = Number(part.slice(0, -1));
  return total + value * { d: 86400, h: 3600, m: 60, s: 1 }[part.slice(-1)];
}, 0);

export async function run({ chat, page, expect, snapshot }) {
  await chat.openNewChat();
  await chat.send('Reply with the single word MANGO and nothing else.');
  await chat.waitForAssistant(/MANGO/, 60000);
  await chat.waitIdle(30000);

  const stamp = page.getByTestId('last-message-stamp');
  await stamp.waitFor({ timeout: 10000 });
  const first = (await stamp.innerText()).trim();
  const firstMatch = first.match(STAMP);
  expect(Boolean(firstMatch), `the stamp reads "${first}"`);

  await page.waitForTimeout(3000);
  const second = (await stamp.innerText()).trim();
  expect(second === first, `three seconds later the stamp has not moved ("${second}")`);

  await page.reload();
  await stamp.waitFor({ timeout: 15000 });
  const third = (await stamp.innerText()).trim();
  const thirdMatch = third.match(STAMP);
  expect(
    Boolean(thirdMatch) && seconds(thirdMatch[1]) >= seconds(firstMatch[1]) + 3,
    `after a reload it is measured again ("${firstMatch[1]}" → "${thirdMatch?.[1]}")`,
  );
  await snapshot('stamp under the last message');

  const placement = await page.evaluate(() => {
    const messages = [...document.querySelectorAll('.chat-messages-pane .chat-message')];
    const lastMessage = messages[messages.length - 1];
    const stampNode = document.querySelector('[data-testid="last-message-stamp"]');
    const row = stampNode?.closest('div');
    const style = stampNode && getComputedStyle(stampNode);
    return {
      insideLast: Boolean(lastMessage?.contains(stampNode)),
      sameRowAsCopy: Boolean(row?.querySelector('button')),
      rightAligned: Boolean(row && Math.abs(row.getBoundingClientRect().right - stampNode.getBoundingClientRect().right) < 2),
      italic: style?.fontStyle === 'italic',
    };
  });
  expect(placement.insideLast && placement.sameRowAsCopy, `the stamp sits on the last reply's copy/speak row (${JSON.stringify(placement)})`);
  expect(placement.rightAligned && placement.italic, 'the stamp is right-aligned and italic');
}
