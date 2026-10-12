// /compact picked from the slash menu in an idle Claude chat: the menu lists
// it among the CLI's own commands, picking it writes it into the composer
// (instructions may follow), and sending it reaches the CLI as typed — the
// composer does not run it through the command API — which compacts and the
// chat shows one "Compacted · manual" row, also after a reload.
export const meta = {
  title: '/compact from the slash menu compacts the idle chat and shows one "Compacted · manual" row',
  timeoutMs: 300000,
};

const ROW = /Compacted · manual/g;

export async function run({ chat, page, expect }) {
  await chat.openNewChat();
  for (const word of ['APPLE', 'BANANA', 'CHERRY']) {
    const before = await chat.assistantMessageCount();
    await chat.send(`Reply with the single word ${word} and nothing else.`);
    await chat.waitForNewAssistant(new RegExp(word), before, 60000);
    await chat.waitIdle(60000);
  }

  await chat.composer().click();
  await chat.composer().pressSequentially('/comp');
  const menu = page.getByRole('listbox', { name: 'Available commands' });
  await menu.waitFor({ timeout: 10000 });
  const option = menu.getByRole('option').filter({ hasText: '/compact' }).first();
  await option.waitFor({ timeout: 10000 });
  expect(
    /Summarize the conversation to free up context/.test(await option.innerText()),
    'the menu lists /compact with its description',
  );
  await option.click();
  const typed = await chat.composer().inputValue();
  expect(typed === '/compact ', `picking it writes it into the composer ("${typed}")`);

  await chat.composer().pressSequentially('keep the fruit words');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await chat.waitForAssistant(/Compacted · manual/, 180000);
  await chat.waitIdle(60000);
  const text = await chat.assistantText();
  expect((text.match(ROW) || []).length === 1, 'one "Compacted · manual" row');
  expect(!/Error executing command/.test(text), 'the composer did not run it as an app command');

  await page.reload();
  await chat.waitForAssistant(/Compacted · manual/, 30000);
  const reloaded = await chat.assistantText();
  expect((reloaded.match(ROW) || []).length === 1, 'after a reload, still one "Compacted · manual" row');
}
