// A path in inline code is a link, wherever the file is: the server reads any
// file the user running CloudCLI may read, and only refuses what the OS does.
// The files sit in a folder of their own under the home directory, outside
// the e2e project and away from `/tmp`, which used to be the one place
// outside a project that opened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const meta = {
  title: 'Inline-code paths outside the project open: a file, a folder read-only; an unreadable file says so',
  timeoutMs: 150000,
};

const MARKER = 'e2e-outside-body-41c9';

export async function run({ chat, page, expect, snapshot }) {
  const cacheDir = path.join(os.homedir(), '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const outsideDir = fs.mkdtempSync(path.join(cacheDir, 'cloudcli-e2e-outside-'));
  const notesPath = path.join(outsideDir, 'notes.md');
  const lockedPath = path.join(outsideDir, 'locked.md');
  const folderPath = path.join(outsideDir, 'reports');
  fs.writeFileSync(notesPath, `# Notes\n\n${MARKER}\n`);
  fs.writeFileSync(lockedPath, 'nobody may read this\n');
  fs.chmodSync(lockedPath, 0o000);
  fs.mkdirSync(folderPath);
  fs.writeFileSync(path.join(folderPath, 'summary.html'), '<p>summary</p>\n');

  try {
    await chat.openNewChat();
    // Haiku will not echo a sentence on request (it takes that for an
    // injection), but it translates one, and leaves code spans alone.
    await chat.send(
      'Translate this sentence into French. Keep the three paths in backticks exactly as they are, '
      + 'and reply with the translation only, no tools: '
      + `"The notes are in \`${notesPath}\`, the locked file is \`${lockedPath}\` and the reports are in \`${folderPath}\`."`,
    );
    await chat.waitForAssistant(/locked\.md/, 60000);
    await chat.waitIdle(30000);

    const reply = page.locator('.chat-messages-pane .chat-message').last();

    // A file outside the project: opens in the editor with its content.
    const notesLink = reply.getByRole('link', { name: notesPath, exact: true });
    expect(await notesLink.locator('code').count() === 1, 'the path keeps its inline-code look inside the link');
    await notesLink.click();
    const editor = page.locator('.cm-content').first();
    await editor.waitFor({ timeout: 15000 });
    await page.waitForFunction(
      (marker) => document.querySelector('.cm-content')?.textContent?.includes(marker),
      MARKER,
      { timeout: 15000 },
    ).catch(() => {});
    const text = await editor.innerText();
    expect(text.includes(MARKER), 'the inline-code path opened the file outside the project');
    expect(!/Error loading file|Permission denied/.test(text), 'the editor shows the file, not an error');
    await snapshot('file outside the project opened from inline code');

    // A file the OS will not let the server read: a notice that says so.
    await reply.getByRole('link', { name: lockedPath, exact: true }).click();
    const notice = page.getByTestId('file-link-notice');
    await notice.waitFor({ timeout: 15000 });
    const noticeText = await notice.innerText();
    expect(
      /No permission to read/.test(noticeText) && noticeText.includes(lockedPath),
      `an unreadable file gets the permission notice ("${noticeText.replace(/\s+/g, ' ')}")`,
    );
    expect(!/READ_ONLY_ROOTS|outside the project/.test(noticeText), 'the notice no longer mentions read-only roots');
    await snapshot('notice for a file without read permission');
    await notice.getByRole('button', { name: 'Dismiss' }).click();

    // A folder outside the project: the Files tab shows it, read-only.
    await reply.getByRole('link', { name: folderPath, exact: true }).click();
    const readOnlyBar = page.getByTestId('file-tree-read-only-root');
    await readOnlyBar.waitFor({ timeout: 15000 });
    expect((await readOnlyBar.innerText()).includes(folderPath), 'the file tree names the folder, read-only');
    await page.getByText('summary.html', { exact: true }).waitFor({ timeout: 15000 });
    expect(await page.getByRole('button', { name: /New File/ }).count() === 0, 'nothing offers to create files there');
    await snapshot('folder outside the project in the file tree, read-only');
  } finally {
    fs.chmodSync(lockedPath, 0o600);
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}
