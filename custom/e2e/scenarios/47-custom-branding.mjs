// Settings → Appearance → Branding: an uploaded image becomes the sidebar logo,
// the favicon and the manifest icons, and a custom name replaces the app name
// in the sidebar, the page title and the manifest. Reset and an empty name go
// back to the stock look. The instance has its own branding folder
// (CLOUDCLI_BRANDING_DIR), so the live app is never rebranded.
export const meta = {
  title: 'Branding: an uploaded icon and app name show in the sidebar, favicon, manifest and title, and reset back to stock',
  timeoutMs: 120000,
};

// A 1x1 red PNG; the server scales it to every icon size.
const RED_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const CUSTOM_NAME = 'Acme Dev';

export async function run({ chat, page, app, expect, snapshot }) {
  const api = async (method, url, body) => {
    const response = await fetch(`${app.base}${url}`, {
      method,
      headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  // The ui-cleanup "Leftover processes" dialog opens on its own when the host has
  // real leftovers and covers the page. Answer its list with nothing; never kill anything.
  await page.route('**/api/plugins/*/rpc/leftovers', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ groups: [], serverStartedAt: 0 }),
  }));
  const leftovers = page.locator('#uic-leftovers');
  if (await leftovers.isVisible().catch(() => false)) {
    await leftovers.getByRole('button', { name: 'Close', exact: true }).click();
  }
  const openAppearance = async () => {
    await page.locator('button:has(svg.lucide-settings)').filter({ visible: true }).first().click();
    await page.getByRole('button', { name: 'Appearance', exact: true }).first().click();
  };
  const resetBranding = async () => {
    await api('DELETE', '/api/branding/icon');
    await api('PUT', '/api/branding/name', { name: '' });
  };

  await resetBranding();
  try {
    await chat.openNewChat();

    const stockManifest = await (await fetch(`${app.base}/manifest.json`)).json();
    expect(!String(stockManifest.icons[0].src).includes('?v='), 'unbranded manifest icons have no version query');

    await openAppearance();
    const uploadInput = page.locator('input[type="file"][aria-label="Upload image"]');
    await uploadInput.waitFor({ state: 'attached', timeout: 10000 });

    await uploadInput.setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: RED_PIXEL_PNG });
    await page.getByRole('button', { name: 'Reset to default' }).waitFor({ timeout: 15000 });

    const nameInput = page.getByRole('textbox', { name: 'App name' });
    await nameInput.fill(CUSTOM_NAME);
    await nameInput.press('Enter');
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('h1')].some((h) => h.textContent === name),
      CUSTOM_NAME,
      { timeout: 10000 },
    );

    const state = (await api('GET', '/api/branding')).body;
    expect(state?.hasIcon === true && /^[a-f0-9]{12}$/.test(state.iconVersion ?? ''), `the server has the icon (${JSON.stringify(state)})`);
    expect(state?.name === CUSTOM_NAME, 'the server has the custom name');

    const favicon = await page.evaluate(() => document.querySelector('link[rel="icon"]')?.getAttribute('href'));
    expect(String(favicon).endsWith(`?v=${state.iconVersion}`), `the open tab's favicon points at the new icon without a reload (${favicon})`);

    await snapshot('settings: Appearance, Branding with the uploaded icon and name');
    await page.keyboard.press('Escape');
    await snapshot('settings closed, sidebar shows the custom icon and name');

    // A fresh load gets the rewritten shell, manifest and icon files.
    await page.reload();
    await chat.openNewChat();
    const logo = page.locator(`img[src="/icons/icon-64x64.png?v=${state.iconVersion}"]`).filter({ visible: true }).first();
    await logo.waitFor({ timeout: 15000 });
    const logoSize = await logo.evaluate((img) => ({ w: img.naturalWidth, h: img.naturalHeight }));
    expect(logoSize.w === 64 && logoSize.h === 64, `the sidebar logo loads the 64px custom icon (${JSON.stringify(logoSize)})`);
    expect((await page.title()).includes(CUSTOM_NAME), `the page title uses the custom name (${await page.title()})`);
    await snapshot('after reload: custom icon and name in the sidebar');

    const html = await (await fetch(`${app.base}/`)).text();
    expect(html.includes(`<title>${CUSTOM_NAME}</title>`), 'index.html has the custom title');
    expect(html.includes(`/favicon.png?v=${state.iconVersion}`), 'index.html favicon link carries the icon version');

    const manifest = await (await fetch(`${app.base}/manifest.json`)).json();
    expect(manifest.name === CUSTOM_NAME && manifest.short_name === CUSTOM_NAME, 'the manifest has the custom name');
    expect(manifest.icons.every((icon) => icon.src.endsWith(`?v=${state.iconVersion}`) && icon.purpose === 'any'), 'manifest icons are versioned and not maskable');

    const faviconResponse = await fetch(`${app.base}/favicon.png`);
    const faviconBytes = Buffer.from(await faviconResponse.arrayBuffer());
    expect(faviconResponse.headers.get('content-type') === 'image/png', 'the favicon is served as PNG');
    expect(faviconBytes.readUInt32BE(16) === 32 && faviconBytes.readUInt32BE(20) === 32, 'the favicon is the 32px custom icon');

    const notAnImage = new FormData();
    notAnImage.append('icon', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
    const rejected = await fetch(`${app.base}/api/branding/icon`, {
      method: 'POST', headers: { Authorization: `Bearer ${app.token}` }, body: notAnImage,
    });
    expect(rejected.status === 400, `a file that is not an image is rejected with 400 (${rejected.status})`);

    const anonymous = await fetch(`${app.base}/api/branding/name`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    });
    expect(anonymous.status === 401, `renaming without a token is refused (${anonymous.status})`);

    // Reset from the UI.
    await openAppearance();
    await page.getByRole('button', { name: 'Reset to default' }).click();
    await page.getByRole('button', { name: 'Reset to default' }).waitFor({ state: 'detached', timeout: 10000 });
    const resetName = page.getByRole('textbox', { name: 'App name' });
    await resetName.fill('');
    await resetName.press('Enter');
    await page.waitForFunction(async () => {
      const body = await (await fetch('/api/branding', { cache: 'no-store' })).json();
      return body.name === null && body.hasIcon === false;
    }, null, { timeout: 10000 });

    const resetHtml = await (await fetch(`${app.base}/`)).text();
    expect(resetHtml.includes('<title>CloudCLI UI</title>') && resetHtml.includes('href="/favicon.png"'), 'after reset index.html is the stock shell');
    const resetManifest = await (await fetch(`${app.base}/manifest.json`)).json();
    expect(resetManifest.name === stockManifest.name && !String(resetManifest.icons[0].src).includes('?v='), 'after reset the manifest is stock');
  } finally {
    await resetBranding();
  }
}
