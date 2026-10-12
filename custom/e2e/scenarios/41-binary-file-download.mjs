// A binary file (a zip) opened from a chat link cannot be shown, but it can be
// downloaded: the button hands over the exact bytes on disk, not the empty
// text buffer the editor keeps for it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const meta = {
  title: 'A binary file opened from chat offers Download, and the download is byte-for-byte the file',
  timeoutMs: 150000,
};

export async function run({ chat, page, expect, snapshot }) {
  const cacheDir = path.join(os.homedir(), '.cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const outsideDir = fs.mkdtempSync(path.join(cacheDir, 'cloudcli-e2e-binary-'));
  const zipPath = path.join(outsideDir, 'bundle.zip');
  // Random bytes with a zip signature: includes NULs and bytes that are not
  // valid UTF-8, which a text round trip would mangle.
  const bytes = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), crypto.randomBytes(4096)]);
  fs.writeFileSync(zipPath, bytes);

  try {
    await chat.openNewChat();
    await chat.send(
      'Translate this sentence into French. Keep the path in backticks exactly as it is, '
      + 'and reply with the translation only, no tools: '
      + `"The bundle is ready at \`${zipPath}\`."`,
    );
    await chat.waitForAssistant(/bundle\.zip/, 60000);
    await chat.waitIdle(30000);

    const reply = page.locator('.chat-messages-pane .chat-message').last();
    await reply.getByRole('link', { name: zipPath, exact: true }).click();

    await page.getByText('Binary File', { exact: true }).waitFor({ timeout: 15000 });
    const downloadButton = page.getByRole('button', { name: 'Download', exact: true });
    expect(await downloadButton.count() >= 1, 'the binary file view offers a Download button');
    await snapshot('binary file view with Download');

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      downloadButton.first().click(),
    ]);
    expect(download.suggestedFilename() === 'bundle.zip', `the download keeps the file name ("${download.suggestedFilename()}")`);
    const savedPath = path.join(outsideDir, 'downloaded.zip');
    await download.saveAs(savedPath);
    const saved = fs.readFileSync(savedPath);
    expect(saved.equals(bytes), `the download is the file's exact bytes (${saved.length} of ${bytes.length})`);
    expect(await page.getByText('Could not download this file.').count() === 0, 'no download error is shown');
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
}
