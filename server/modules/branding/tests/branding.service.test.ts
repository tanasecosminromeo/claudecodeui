import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import {
  BRANDING_ICON_SIZES,
  BrandingValidationError,
  iconFileName,
  normalizeBrandingName,
  readBrandingState,
  removeBrandingIcon,
  saveBrandingIcon,
  setBrandingName,
} from '@/modules/branding/services/branding.service.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'branding-test-'));
}

/** A non-square PNG, so the center-crop path is exercised. */
async function makeWidePng(): Promise<Buffer> {
  return sharp({
    create: { width: 300, height: 120, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
}

test('normalizeBrandingName trims, clears empty names, and rejects bad input', () => {
  assert.equal(normalizeBrandingName('  Acme Dev  '), 'Acme Dev');
  assert.equal(normalizeBrandingName('   '), null);
  assert.equal(normalizeBrandingName(''), null);
  assert.equal(normalizeBrandingName('a'.repeat(40)), 'a'.repeat(40));
  assert.throws(() => normalizeBrandingName('a'.repeat(41)), BrandingValidationError);
  assert.throws(() => normalizeBrandingName('bad\nname'), BrandingValidationError);
  assert.throws(() => normalizeBrandingName(42), BrandingValidationError);
});

test('a missing branding folder reads as defaults', async () => {
  const dir = path.join(await makeTempDir(), 'does-not-exist');
  assert.deepEqual(readBrandingState(dir), { name: null, iconVersion: null, hasIcon: false });
});

test('saveBrandingIcon writes every icon size as a square PNG and sets a version', async () => {
  const dir = await makeTempDir();
  const state = await saveBrandingIcon(await makeWidePng(), dir);

  assert.equal(state.hasIcon, true);
  assert.match(state.iconVersion ?? '', /^[a-f0-9]{12}$/);

  for (const size of BRANDING_ICON_SIZES) {
    const meta = await sharp(path.join(dir, iconFileName(size))).metadata();
    assert.equal(meta.format, 'png', `size ${size} is a PNG`);
    assert.equal(meta.width, size, `size ${size} width`);
    assert.equal(meta.height, size, `size ${size} height`);
  }
});

test('saveBrandingIcon accepts SVG input and rejects non-image bytes with a validation error', async () => {
  const dir = await makeTempDir();
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#06c"/></svg>',
  );
  const state = await saveBrandingIcon(svg, dir);
  assert.equal(state.hasIcon, true);

  await assert.rejects(
    () => saveBrandingIcon(Buffer.from('this is not an image'), dir),
    BrandingValidationError,
  );
});

test('a rejected upload leaves the previous icon in place', async () => {
  const dir = await makeTempDir();
  const first = await saveBrandingIcon(await makeWidePng(), dir);
  await assert.rejects(() => saveBrandingIcon(Buffer.from('garbage'), dir), BrandingValidationError);
  assert.equal(readBrandingState(dir).iconVersion, first.iconVersion);
});

test('setBrandingName stores a trimmed name and an empty name clears it', async () => {
  const dir = await makeTempDir();
  assert.equal((await setBrandingName('  Team Tools ', dir)).name, 'Team Tools');
  assert.equal(readBrandingState(dir).name, 'Team Tools');
  assert.equal((await setBrandingName('', dir)).name, null);
  await assert.rejects(() => setBrandingName('x'.repeat(41), dir), BrandingValidationError);
});

test('removeBrandingIcon deletes the icon files, keeps the name, and resets the version', async () => {
  const dir = await makeTempDir();
  await setBrandingName('Kept', dir);
  await saveBrandingIcon(await makeWidePng(), dir);

  const state = await removeBrandingIcon(dir);
  assert.deepEqual(state, { name: 'Kept', iconVersion: null, hasIcon: false });
  for (const size of BRANDING_ICON_SIZES) {
    await assert.rejects(() => fs.access(path.join(dir, iconFileName(size))));
  }
});
