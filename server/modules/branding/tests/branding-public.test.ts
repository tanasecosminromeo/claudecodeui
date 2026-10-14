import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';
import sharp from 'sharp';

import { createBrandingPublicRouter } from '@/modules/branding/branding-public.routes.js';
import {
  renderBrandedIndexHtml,
  pickIconSize,
} from '@/modules/branding/services/branding-public.service.js';
import {
  saveBrandingIcon,
  setBrandingName,
} from '@/modules/branding/services/branding.service.js';

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="icon" type="image/png" href="/favicon.png" />
    <title>CloudCLI UI</title>
    <link rel="manifest" href="/manifest.json" crossorigin="use-credentials"  />
    <meta name="apple-mobile-web-app-title" content="Claude UI" />
    <link rel="apple-touch-icon" sizes="152x152" href="/icons/icon-152x152.png" />
    <link rel="apple-touch-icon" sizes="180x180" href="/icons/icon-192x192.png" />
  </head>
  <body><div id="root"></div></body>
</html>
`;

const STOCK_MANIFEST = {
  name: 'CloudCLI UI',
  short_name: 'CloudCLI UI',
  start_url: '/',
  icons: [
    { src: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable any' },
  ],
};

async function makeFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'branding-public-'));
  const publicDir = path.join(root, 'public');
  const distDir = path.join(root, 'dist');
  const brandingDir = path.join(root, 'branding');
  await fs.mkdir(publicDir, { recursive: true });
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(path.join(publicDir, 'manifest.json'), JSON.stringify(STOCK_MANIFEST));
  await fs.writeFile(path.join(publicDir, 'favicon.png'), 'STOCK-FAVICON');
  await fs.writeFile(path.join(distDir, 'index.html'), INDEX_HTML);
  return { publicDir, distDir, brandingDir };
}

/** Runs the same middleware order as server/index.ts: branding overrides, then the stock public files. */
async function startServer(fixture: { publicDir: string; distDir: string; brandingDir: string }) {
  const app = express();
  app.use(createBrandingPublicRouter(fixture));
  app.use(express.static(fixture.publicDir));
  app.use(express.static(fixture.distDir));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: (pathname: string) => `http://127.0.0.1:${port}${pathname}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function makeIconPng(): Promise<Buffer> {
  return sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 90, b: 200, alpha: 1 } } })
    .png()
    .toBuffer();
}

test('unbranded: the stock manifest, favicon, and index.html pass through unchanged', async () => {
  const fixture = await makeFixture();
  const server = await startServer(fixture);
  try {
    const manifest = await fetch(server.url('/manifest.json'));
    assert.deepEqual(await manifest.json(), STOCK_MANIFEST);
    assert.notEqual(manifest.headers.get('cache-control'), 'no-cache');

    const favicon = await fetch(server.url('/favicon.png'));
    assert.equal(await favicon.text(), 'STOCK-FAVICON');

    const index = await fetch(server.url('/'));
    assert.equal(await index.text(), INDEX_HTML);
  } finally {
    await server.close();
  }
});

test('a custom name rewrites the manifest, the title, and the iOS title only', async () => {
  const fixture = await makeFixture();
  await setBrandingName('Acme "Dev" & Co', fixture.brandingDir);
  const server = await startServer(fixture);
  try {
    const manifest = (await (await fetch(server.url('/manifest.json'))).json()) as typeof STOCK_MANIFEST;
    assert.equal(manifest.name, 'Acme "Dev" & Co');
    assert.equal(manifest.short_name, 'Acme "Dev" & Co');
    assert.equal(manifest.icons[0].src, '/icons/icon-192x192.png', 'no icon version without an icon');

    const html = await (await fetch(server.url('/'))).text();
    assert.match(html, /<title>Acme &quot;Dev&quot; &amp; Co<\/title>/);
    assert.match(html, /name="apple-mobile-web-app-title" content="Acme &quot;Dev&quot; &amp; Co"/);
    assert.match(html, /href="\/favicon\.png"/, 'favicon URL is not versioned without an icon');
  } finally {
    await server.close();
  }
});

test('a custom icon serves PNGs, versions the URLs, and drops the SVG favicon link', async () => {
  const fixture = await makeFixture();
  const state = await saveBrandingIcon(await makeIconPng(), fixture.brandingDir);
  const version = state.iconVersion;
  const server = await startServer(fixture);
  try {
    const favicon = await fetch(server.url('/favicon.png'));
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get('content-type'), 'image/png');
    assert.equal(favicon.headers.get('cache-control'), 'no-cache');
    const faviconMeta = await sharp(Buffer.from(await favicon.arrayBuffer())).metadata();
    assert.equal(faviconMeta.width, 32);

    const svgFavicon = await fetch(server.url('/favicon.svg'));
    assert.equal(svgFavicon.headers.get('content-type'), 'image/png');

    const sized = await fetch(server.url('/icons/icon-64x64.png'));
    const sizedMeta = await sharp(Buffer.from(await sized.arrayBuffer())).metadata();
    assert.equal(sizedMeta.width, 64);

    const manifest = (await (await fetch(server.url('/manifest.json'))).json()) as typeof STOCK_MANIFEST & {
      icons: Array<{ src: string; purpose: string }>;
    };
    assert.equal(manifest.name, 'CloudCLI UI', 'stock name kept when only the icon is custom');
    assert.equal(manifest.icons[0].src, `/icons/icon-192x192.png?v=${version}`);
    assert.equal(manifest.icons[0].purpose, 'any');

    const html = await (await fetch(server.url('/'))).text();
    assert.doesNotMatch(html, /favicon\.svg/);
    assert.match(html, new RegExp(`href="/favicon\\.png\\?v=${version}"`));
    assert.match(html, new RegExp(`href="/manifest\\.json\\?v=${version}"`));
    assert.match(html, new RegExp(`href="/icons/icon-152x152\\.png\\?v=${version}"`));
    assert.match(html, /<title>CloudCLI UI<\/title>/);
  } finally {
    await server.close();
  }
});

test('index.html rewrite leaves the markup alone when nothing is branded', () => {
  const state = { name: null, iconVersion: null, hasIcon: false };
  assert.equal(renderBrandedIndexHtml(INDEX_HTML, state), INDEX_HTML);
});

test('a name containing replacement patterns is inserted literally', () => {
  const html = renderBrandedIndexHtml(INDEX_HTML, { name: 'Cost $& more', iconVersion: null, hasIcon: false });
  assert.match(html, /<title>Cost \$&amp; more<\/title>/);
});

test('pickIconSize chooses the smallest stored size that is big enough', () => {
  assert.equal(pickIconSize(32), 32);
  assert.equal(pickIconSize(40), 64);
  assert.equal(pickIconSize(256), 384);
  assert.equal(pickIconSize(9999), 512);
});

test('the branding API is public for reads and requires auth for writes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'branding-api-'));
  const previous = process.env.CLOUDCLI_BRANDING_DIR;
  process.env.CLOUDCLI_BRANDING_DIR = dir;
  try {
    const { brandingRoutes } = await import('@/modules/branding/index.js');
    const app = express();
    app.use(express.json());
    app.use('/api/branding', brandingRoutes);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const url = (pathname: string) => `http://127.0.0.1:${port}/api/branding${pathname}`;
    try {
      const read = await fetch(url('/'));
      assert.equal(read.status, 200);
      assert.deepEqual(await read.json(), { name: null, iconVersion: null, hasIcon: false });

      const write = await fetch(url('/name'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Nope' }),
      });
      assert.equal(write.status, 401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  } finally {
    if (previous === undefined) {
      delete process.env.CLOUDCLI_BRANDING_DIR;
    } else {
      process.env.CLOUDCLI_BRANDING_DIR = previous;
    }
  }
});
