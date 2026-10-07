// A reply often names a folder once and links its files by bare name:
// "Two reports, both under `/tmp/…/files/`: [report.html](report.html)".
// Clicking such a link used to open `report.html` against the project root
// and show "// Error loading file: File not found". Now the link is looked for
// in the folders its message mentions, and one found nowhere explains itself
// in a notice instead of opening an empty editor.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const meta = {
  title: 'A bare file link opens from the folder its message names; a missing one says so',
  timeoutMs: 150000,
};

const MARKER = 'e2e-report-body-7f3a';

export async function run({ chat, page, expect, snapshot }) {
  // The temp directory is a read-only root, so the server may read it.
  const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-e2e-links-'));
  fs.writeFileSync(path.join(filesDir, 'report.html'), `<!doctype html><p>${MARKER}</p>\n`);

  try {
    await chat.openNewChat();
    await chat.send(
      `I saved a report named report.html in the folder \`${filesDir}/\`. Reply with two short markdown lines and nothing else: `
      + `the first names that folder in backticks; the second links the report by its bare name as [report.html](report.html) `
      + 'and a second file as [missing.html](missing.html).',
    );
    await chat.waitForAssistant(/report\.html/, 60000);
    await chat.waitIdle(30000);

    const reply = page.locator('.chat-messages-pane .chat-message').last();
    await reply.getByRole('link', { name: 'report.html', exact: true }).click();
    const editor = page.locator('.cm-content').first();
    await editor.waitFor({ timeout: 15000 });
    await page.waitForFunction(
      (marker) => document.querySelector('.cm-content')?.textContent?.includes(marker),
      MARKER,
      { timeout: 15000 },
    ).catch(() => {});
    const text = await editor.innerText();
    expect(text.includes(MARKER), 'the bare link opened the report from the folder the message named');
    expect(!text.includes('Error loading file'), 'the editor did not show "File not found"');
    await snapshot('report opened from the named folder');

    await reply.getByRole('link', { name: 'missing.html', exact: true }).click();
    const notice = page.getByTestId('file-link-notice');
    await notice.waitFor({ timeout: 15000 });
    const noticeText = await notice.innerText();
    expect(/File not found/.test(noticeText) && noticeText.includes('missing.html'), `a missing file gets a notice ("${noticeText.replace(/\s+/g, ' ')}")`);
    await snapshot('notice for a missing file');
  } finally {
    fs.rmSync(filesDir, { recursive: true, force: true });
  }
}
