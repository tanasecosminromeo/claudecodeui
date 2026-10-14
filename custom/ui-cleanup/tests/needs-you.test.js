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

const row = (over = {}) => ({
  sessionId: 'claude-1', appSessionId: 'claude-1', state: 'waiting', entrypoint: 'cli',
  waitingFor: 'permission prompt', pending: null, title: 'demo', project: 'app', ...over,
});
// A blocked entry as the radar lists it (no state, no entrypoint).
const blocked = (over = {}) => ({
  sessionId: 'prov-b', appSessionId: 'app-b', title: 'Fix login', project: 'app', ...over,
});
const pill = () => document.getElementById('uic-alert');
const icon = () => document.querySelector('link[rel~="icon"]');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('needs-you: blocked sessions count with the cards', () => {
  const RealImage = globalThis.Image;
  let uic;

  beforeEach(() => {
    // jsdom loads no images: fail each one at once, and let the lit/dim frames differ.
    globalThis.Image = class {
      set src(value) { queueMicrotask(() => this.onerror && this.onerror()); }
    };
    HTMLCanvasElement.prototype.getContext = function getContext() {
      const canvas = this;
      return {
        drawImage() {}, beginPath() {}, arc() {}, fill() {}, stroke() {},
        set fillStyle(v) { canvas.dataset.fill = v; },
      };
    };
    HTMLCanvasElement.prototype.toDataURL = function toDataURL() {
      return `data:image/png;base64,${this.dataset.fill}`;
    };
    document.body.innerHTML = '';
    document.head.innerHTML = '<link rel="icon" type="image/png" href="/favicon.png">';
    delete document.documentElement.dataset.uicWaiting;
    delete document.documentElement.dataset.envswWaiting;
    delete window.__uicSessionStates;
    history.replaceState({}, '', '/');
    uic = loadCleanup();
  });

  afterEach(() => {
    uic.updateAlert([], []); // stops the pulse this test started
    globalThis.Image = RealImage;
    document.head.innerHTML = '';
  });

  it('a blocked session alone pulses the favicon, shows in the pill, and is not a card', async () => {
    uic.updateAlert([], [blocked()]);
    await wait(30);
    expect(pill().querySelector('.uic-alert-text').textContent).toBe('Needs input: Fix login');
    expect(window.__uicSessionStates).toEqual({ waiting: [], busy: [] });
    expect(icon().getAttribute('href')).toMatch(/^data:/);
    // the pulse alternates between the lit and the dim frame
    const first = icon().getAttribute('href');
    await wait(750);
    expect(icon().getAttribute('href')).toMatch(/^data:/);
    expect(icon().getAttribute('href')).not.toBe(first);
  });

  it('a blocked session that is also a card is counted once', () => {
    uic.updateAlert([row({ appSessionId: 'app-b', sessionId: 'prov-b' })], [blocked()]);
    expect(document.documentElement.dataset.uicWaiting).toBe('1');
    expect(pill().querySelector('.uic-alert-more').textContent).toBe('');
    expect(window.__uicSessionStates.waiting).toEqual(['app-b']);
  });

  it('an emptied blocked list stops the pulse and hides the pill', async () => {
    uic.updateAlert([], [blocked()]);
    await wait(30);
    expect(icon().getAttribute('href')).toMatch(/^data:/);
    uic.updateAlert([], []);
    expect(pill()).toBeNull();
    expect(icon().getAttribute('href')).toBe('/favicon.png');
    expect(document.documentElement.dataset.uicWaiting).toBe('0');
  });

  it('the env-switcher count (dataset) includes blocked sessions', () => {
    const second = blocked({ sessionId: 'p9', appSessionId: 'a9', title: 'Second' });
    uic.updateAlert([row({ appSessionId: 'a1' })], [blocked(), second]);
    expect(document.documentElement.dataset.uicWaiting).toBe('3');
    expect(window.__uicSessionStates.waiting).toEqual(['a1']);
  });

  it('keeps the pulse while the open session is the only one needing you, and hides the pill', async () => {
    history.replaceState({}, '', '/session/app-b');
    uic.updateAlert([], [blocked()]);
    await wait(30);
    expect(pill()).toBeNull();
    expect(icon().getAttribute('href')).toMatch(/^data:/);
  });

  it('keeps the pulse for a card when the user opens it, and pill points at the other one', async () => {
    history.replaceState({}, '', '/session/a1');
    uic.updateAlert([row({ appSessionId: 'a1' })], [blocked()]);
    await wait(30);
    expect(pill().querySelector('.uic-alert-text').textContent).toBe('Needs input: Fix login');
    expect(icon().getAttribute('href')).toMatch(/^data:/);
  });
});
