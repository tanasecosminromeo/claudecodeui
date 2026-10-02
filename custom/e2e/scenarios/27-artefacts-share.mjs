// Publishing (custom/share) shows up in the sidebar: the Conversations tab is
// relabelled Artefacts and lists the share under its session, with the public
// link served by the share service without any login. Uses a separate share
// (90m) in the real ~/shares and deletes it at the end.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARE_CLI = fileURLToPath(new URL('../../share/share.mjs', import.meta.url));
const SHARE_PORT = Number(process.env.SHARE_PORT) || 3002;
// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

export const meta = {
  title: 'Artefacts: the Conversations tab lists published shares; the public link needs no login',
  timeoutMs: 150000,
};

export async function run({ chat, page, expect, snapshot }) {
  await chat.openNewChat();
  await chat.send('Reply with the single word MANGO and nothing else.');
  const sessionId = await chat.sessionId();
  await chat.waitForAssistant(/./, 60000);
  await chat.waitIdle(60000);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-artefact-'));
  fs.mkdirSync(path.join(dir, 'fixture-report', 'shots'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixture-report', 'index.html'), '<h1>Fixture</h1><img src="shots/a.png">');
  fs.writeFileSync(path.join(dir, 'fixture-report', 'shots', 'a.png'), PNG);
  const out = execFileSync(process.execPath, [SHARE_CLI, 'publish', path.join(dir, 'fixture-report'),
    '--title', 'E2E fixture report', '--dest', 'reports', '--separate', '--ttl', '90m', '--session', sessionId], { encoding: 'utf8' });
  const itemUrl = out.match(/-> (\S+)/)[1];
  const shareId = itemUrl.split('/share/')[1].split('/')[0];

  try {
    const tab = page.locator('button:has(svg.lucide-message-square)').first();
    await page.waitForFunction(() => [...document.querySelectorAll('button')]
      .some((b) => b.querySelector('svg.lucide-message-square') && b.textContent.trim() === 'Artefacts'), null, { timeout: 15000 });
    expect(true, 'the Conversations tab reads "Artefacts"');
    await tab.click();
    const panel = page.locator('[data-uic-artefacts]');
    await panel.waitFor({ timeout: 15000 });
    const group = panel.locator('.sa-group', { hasText: 'E2E fixture report' });
    await group.waitFor({ timeout: 20000 });
    expect(await group.locator('.sa-tag').innerText() === 'separate', 'the share is tagged separate');
    expect(/until/.test(await group.locator('.sa-exp').innerText()), 'the share shows its expiry');
    expect(await group.locator('.sa-row').count() === 1, 'one row for the one publish');
    await snapshot('artefacts list');

    // The public side: straight to the share service, no CloudCLI token, no cookie.
    const local = itemUrl.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${SHARE_PORT}`);
    const html = await fetch(local);
    expect(html.status === 200 && (await html.text()).includes('<img src="shots/a.png">'), `the report is served (${html.status})`);
    const img = await fetch(local.replace(/index\.html$/, 'shots/a.png'));
    expect(img.status === 200 && img.headers.get('content-type') === 'image/png', 'its relative screenshot is served');
    const wrong = await fetch(local.replace(/\/share\/([^/]+)\/[^/]+\//, '/share/$1/not-the-token/'));
    expect(wrong.status === 404, 'a wrong token is a 404');

    await group.locator('[data-act="session"]').click();
    await page.waitForURL(new RegExp(`/session/${sessionId}$`), { timeout: 10000 });
    expect(true, 'Open session goes to the session the share came from');

    await page.locator('button:has(svg.lucide-folder)').first().click();
    await panel.waitFor({ state: 'detached', timeout: 10000 });
    expect(true, 'leaving the tab gives the normal list back');
  } finally {
    execFileSync(process.execPath, [SHARE_CLI, 'purge', shareId]);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
