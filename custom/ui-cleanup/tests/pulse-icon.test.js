import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// path, not new URL(): under jsdom the global URL is jsdom's, which fs doesn't accept
const SOURCE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cleanup.js'), 'utf8');

function loadCleanup() {
  globalThis.__UIC_TEST__ = {};
  new Function(SOURCE)();
  const api = globalThis.__UIC_TEST__;
  delete globalThis.__UIC_TEST__;
  return api;
}

// jsdom loads no images: record each src and fail it at once, so the frames resolve.
describe('favicon pulse frames', () => {
  const RealImage = globalThis.Image;
  let loaded;

  beforeEach(() => {
    loaded = [];
    globalThis.Image = class {
      set src(value) { loaded.push(value); queueMicrotask(() => this.onerror && this.onerror()); }
    };
    HTMLCanvasElement.prototype.getContext = () => ({
      drawImage() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
    });
    HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,AAAA';
  });

  afterEach(() => {
    globalThis.Image = RealImage;
    document.head.innerHTML = '';
  });

  it('draws from the icon the page shows now, with its version', async () => {
    document.head.innerHTML = '<link rel="icon" type="image/png" href="/favicon.png?v=new1">';
    const uic = loadCleanup();
    await uic.buildIconFrames();
    expect(loaded).toEqual(['/favicon.png?v=new1']);
  });

  it('draws new frames after the app icon changes, instead of keeping the first ones', async () => {
    document.head.innerHTML = '<link rel="icon" type="image/png" href="/favicon.png?v=old">';
    const uic = loadCleanup();
    await uic.buildIconFrames();
    await uic.buildIconFrames();
    document.querySelector('link[rel~="icon"]').setAttribute('href', '/favicon.png?v=avatar');
    await uic.buildIconFrames();
    expect(loaded).toEqual(['/favicon.png?v=old', '/favicon.png?v=avatar']);
  });
});
