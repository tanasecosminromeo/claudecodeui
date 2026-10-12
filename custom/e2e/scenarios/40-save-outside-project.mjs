// A file outside the project can be edited and saved, but the first save asks
// first; a file the server may not write opens read-only with a badge. The
// files sit in a folder of their own under ~/.cache, away from the project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const meta = {
  title: 'Saving outside the project asks once; a file without write permission opens read-only',
  timeoutMs: 180000,
};

export async function run({ chat, page, expect, snapshot }) {
  const cacheDir = path.join(os.homedir(), '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const outsideDir = fs.mkdtempSync(path.join(cacheDir, 'cloudcli-e2e-save-'));
  const notesPath = path.join(outsideDir, 'notes.md');
  const lockedPath = path.join(outsideDir, 'locked.md');
  fs.writeFileSync(notesPath, '# Notes\n');
  fs.writeFileSync(lockedPath, '# Locked\n');
  fs.chmodSync(lockedPath, 0o444);

  const typeAtEnd = async (text) => {
    await page.locator('.cm-content').first().click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(text);
  };
  const dialog = page.getByRole('dialog', { name: 'Save outside the project?' });

  try {
    await chat.openNewChat();
    await chat.send(
      'Translate this sentence into French. Keep the two paths in backticks exactly as they are, '
      + 'and reply with the translation only, no tools: '
      + `"The notes are in \`${notesPath}\` and the locked file is \`${lockedPath}\`."`,
    );
    await chat.waitForAssistant(/locked\.md/, 60000);
    await chat.waitIdle(30000);
    const reply = page.locator('.chat-messages-pane .chat-message').last();

    // Outside the project: the first save asks, Cancel keeps the file as it was.
    await reply.getByRole('link', { name: notesPath, exact: true }).click();
    await page.locator('.cm-content').first().waitFor({ timeout: 15000 });
    await typeAtEnd('first line\n');
    await page.getByTitle('Save', { exact: true }).click();
    await dialog.waitFor({ timeout: 10000 });
    expect((await dialog.innerText()).includes(notesPath), 'the confirm names the file outside the project');
    await page.waitForTimeout(400); // the dialog fades in
    await snapshot('confirm before saving outside the project');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(fs.readFileSync(notesPath, 'utf8') === '# Notes\n', 'Cancel leaves the file on disk unchanged');

    // Save in the dialog writes it; a second save does not ask again.
    await page.getByTitle('Save', { exact: true }).click();
    await dialog.waitFor({ timeout: 10000 });
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    for (let i = 0; i < 20 && !fs.readFileSync(notesPath, 'utf8').includes('first line'); i++) {
      await page.waitForTimeout(250);
    }
    expect(fs.readFileSync(notesPath, 'utf8').includes('first line'), 'Save in the dialog wrote the file outside the project');
    await typeAtEnd('second line\n');
    await page.keyboard.press('Control+s');
    for (let i = 0; i < 20 && !fs.readFileSync(notesPath, 'utf8').includes('second line'); i++) {
      await page.waitForTimeout(250);
    }
    expect(await dialog.count() === 0, 'the second save did not ask again');
    expect(fs.readFileSync(notesPath, 'utf8').includes('second line'), 'Ctrl+S saved the second change');

    // No write permission: a Read-only badge and no Save.
    await reply.getByRole('link', { name: lockedPath, exact: true }).click();
    const badge = page.getByTitle('No permission to write this file.');
    await badge.waitFor({ timeout: 15000 });
    expect((await badge.innerText()).trim() === 'Read-only', 'the editor shows a Read-only badge');
    expect(await page.getByTitle('Save', { exact: true }).count() === 0, 'a file without write permission offers no Save');
    await snapshot('read-only file outside the project');
  } finally {
    fs.chmodSync(lockedPath, 0o644);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}
