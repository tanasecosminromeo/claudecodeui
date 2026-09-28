import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// path, not new URL(): under jsdom the global URL is jsdom's, which fs doesn't accept
const SOURCE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'switcher.js'), 'utf8');
const ENVS = [
  { name: 'Dev', origin: 'https://dev.example.com' },
  { name: 'M4', origin: 'https://m4.example.com' },
];

// Evaluates switcher.js with the test hook set, so it exports its helpers instead of auto-starting.
function loadSwitcher() {
  globalThis.__ENVSW_TEST__ = {};
  new Function(SOURCE)();
  const api = globalThis.__ENVSW_TEST__;
  delete globalThis.__ENVSW_TEST__;
  return api;
}

function renderPage(envs = ENVS) {
  document.head.innerHTML = `<title>Home app</title><script id="envsw-config" type="application/json">${JSON.stringify({ envs })}</script>`;
  document.body.innerHTML = `
    <div id="root">
      <div class="flex-shrink-0">
        <div class="flex min-w-0 items-center gap-2.5"><div class="h-7 w-7"><svg></svg></div><h1>CloudCLI</h1></div>
      </div>
    </div>`;
}

const flush = () => new Promise((resolve) => { queueMicrotask(resolve); });
const logo = () => document.querySelector('[data-envsw-logo]');
const frameOf = (ctl, id = 'env1') => ctl.frames.get(id);
const fromFrame = (f, data, origin = f.env.origin) =>
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: f.el.contentWindow }));

let api;
let ctl;

beforeEach(() => {
  api = loadSwitcher();
  sessionStorage.clear();
  delete document.documentElement.dataset.envswWaiting;
  delete document.documentElement.dataset.uicWaiting;
  vi.stubGlobal('fetch', vi.fn(async () => ({ type: 'basic', status: 200 })));
  renderPage();
});

afterEach(() => {
  if (ctl && ctl.destroy) ctl.destroy();
  ctl = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

describe('pure helpers', () => {
  it('parses the injected config and ignores malformed entries', () => {
    const envs = api.parseConfig(JSON.stringify({ envs: [...ENVS, { name: 3 }, null] }));
    expect(envs).toEqual([
      { id: 'env0', index: 0, name: 'Dev', origin: 'https://dev.example.com', host: 'dev.example.com' },
      { id: 'env1', index: 1, name: 'M4', origin: 'https://m4.example.com', host: 'm4.example.com' },
    ]);
    expect(api.parseConfig('not json')).toEqual([]);
    expect(api.parseConfig('{}')).toEqual([]);
  });

  it('accepts only in-app paths', () => {
    expect(api.safePath('/')).toBe('/');
    expect(api.safePath('/session/abc?x=1')).toBe('/session/abc?x=1');
    for (const bad of ['//evil.example.com', 'https://evil.example.com', '/a\\b', '', 'session', '/'.repeat(2049), 7]) {
      expect(api.safePath(bad)).toBeNull();
    }
  });

  it('classifies the Access probe', () => {
    expect(api.classifyProbe({ type: 'opaqueredirect', status: 0 })).toBe('auth');
    expect(api.classifyProbe({ type: 'basic', status: 530 })).toBe('down');
    expect(api.classifyProbe({ type: 'basic', status: 502 })).toBe('down');
    expect(api.classifyProbe({ type: 'basic', status: 200 })).toBe('ok');
    expect(api.classifyProbe({ type: 'basic', status: 401 })).toBe('ok');
    expect(api.classifyProbe(null)).toBe('offline');
  });

  it('validates and normalises messages', () => {
    expect(api.validateMessage({ type: 'envsw:nope' })).toBeNull();
    expect(api.validateMessage('envsw:hello')).toBeNull();
    expect(api.validateMessage({ type: 'envsw:hello' })).toEqual({ type: 'envsw:hello' });
    expect(api.validateMessage({ type: 'envsw:open-menu', rect: { left: 1, top: 2, right: 3, bottom: 'x' } })).toBeNull();
    expect(api.validateMessage({ type: 'envsw:title', title: 'a'.repeat(500) }).title).toHaveLength(200);
    expect(api.validateMessage({ type: 'envsw:path', path: '//evil.example.com' })).toBeNull();
    expect(api.validateMessage({ type: 'envsw:waiting', count: 150 }).count).toBe(99);
    expect(api.validateMessage({ type: 'envsw:waiting', count: -3 }).count).toBe(0);
    expect(api.validateMessage({ type: 'envsw:waiting', count: 'x' }).count).toBe(0);
    expect(api.validateMessage({ type: 'envsw:probe', state: 'pwned' })).toBeNull();
    expect(api.validateMessage({ type: 'envsw:switch', index: 9 })).toBeNull();
    expect(api.validateMessage({ type: 'envsw:switch', index: 1 })).toEqual({ type: 'envsw:switch', index: 1 });
  });

  it('only returns to another configured origin', () => {
    const envs = api.parseConfig(JSON.stringify({ envs: ENVS }));
    expect(api.returnOrigin(envs, 'https://dev.example.com', 'https://m4.example.com')).toBe('https://dev.example.com');
    expect(api.returnOrigin(envs, 'https://m4.example.com', 'https://m4.example.com')).toBeNull();
    expect(api.returnOrigin(envs, 'https://dev.example.com.evil.example', 'https://m4.example.com')).toBeNull();
    expect(api.returnOrigin(envs, null, 'https://m4.example.com')).toBeNull();
  });

  it('maps Ctrl+Option+digit by key code', () => {
    const key = (code, mods) => ({ code, ctrlKey: true, altKey: true, metaKey: false, shiftKey: false, ...mods });
    expect(api.shortcutIndex(key('Digit3'))).toBe(2);
    expect(api.shortcutIndex(key('Digit0'))).toBeNull();
    expect(api.shortcutIndex(key('Digit1', { metaKey: true }))).toBeNull();
    expect(api.shortcutIndex(key('Digit1', { altKey: false }))).toBeNull();
  });
});

describe('host mode', () => {
  it('does nothing without a config', () => {
    document.head.innerHTML = '';
    expect(api.start()).toBeNull();
    expect(logo()).toBeNull();
  });

  it('marks the logo and re-marks it after React replaces it', async () => {
    ctl = api.start();
    expect(ctl.mode).toBe('host');
    expect(logo().getAttribute('data-envsw-label')).toBe('Dev');
    vi.useFakeTimers();
    document.querySelector('.flex-shrink-0').innerHTML = '<div class="flex min-w-0 items-center"><div><svg></svg></div><h1>CloudCLI</h1></div>';
    await flush();
    vi.advanceTimersByTime(60);
    expect(logo().getAttribute('data-envsw-label')).toBe('Dev');
  });

  it('opens the menu from the logo and closes it with Escape', () => {
    ctl = api.start();
    logo().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const rows = [...document.querySelectorAll('.envsw-menu .envsw-row')];
    expect(rows.map((r) => r.dataset.state)).toEqual(['here', 'idle']);
    expect(rows[0].getAttribute('aria-current')).toBe('true');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.envsw-menu')).toBeNull();
  });

  it('shows a remote env in a kept-alive iframe and makes home inert', () => {
    ctl = api.start();
    ctl.switchTo('env1');
    const f = frameOf(ctl);
    expect(f.el.getAttribute('src')).toBe('https://m4.example.com/');
    expect(f.el.getAttribute('allow')).toContain('microphone');
    expect(f.el.classList.contains('envsw-on')).toBe(true);
    expect(document.getElementById('root').hasAttribute('inert')).toBe(true);
    expect(document.documentElement.getAttribute('data-envsw-remote')).toBe('M4');

    ctl.switchTo(null);
    expect(document.getElementById('root').hasAttribute('inert')).toBe(false);
    expect(document.documentElement.hasAttribute('data-envsw-remote')).toBe(false);
    expect(f.el.isConnected).toBe(true); // still loaded
    expect(f.el.classList.contains('envsw-on')).toBe(false);
  });

  it('marks a frame blocked when it loads without saying hello, and offers sign-in', () => {
    vi.useFakeTimers();
    ctl = api.start();
    ctl.switchTo('env1');
    const f = frameOf(ctl);
    f.el.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(1500);
    expect(f.status).toBe('blocked');
    const buttons = [...document.querySelectorAll('.envsw-overlay .envsw-btn')].map((b) => b.textContent);
    expect(buttons).toEqual(['Sign in', 'Open in new tab', 'Retry', 'Back to Dev']);
  });

  it('treats a hello before or after load as ready', () => {
    vi.useFakeTimers();
    ctl = api.start();
    ctl.switchTo('env1');
    const f = frameOf(ctl);
    fromFrame(f, { type: 'envsw:hello' });
    f.el.dispatchEvent(new Event('load'));
    vi.advanceTimersByTime(5000);
    expect(f.status).toBe('ready');
    expect(document.querySelector('.envsw-overlay')).toBeNull();
  });

  it('ignores messages from other windows or origins', () => {
    ctl = api.start();
    ctl.switchTo('env1');
    const f = frameOf(ctl);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'envsw:hello' }, origin: f.env.origin, source: window }));
    fromFrame(f, { type: 'envsw:hello' }, 'https://evil.example.com');
    expect(f.status).toBe('loading');
  });

  it('mirrors the remote title and restores the home title', async () => {
    ctl = api.start();
    ctl.switchTo('env1');
    const f = frameOf(ctl);
    fromFrame(f, { type: 'envsw:title', title: 'Session A' });
    expect(document.title).toBe('M4 · Session A');
    document.title = 'Home 2'; // the hidden home app keeps writing its title
    await flush();
    expect(document.title).toBe('M4 · Session A');
    ctl.switchTo(null);
    expect(document.title).toBe('Home 2');
  });

  it('publishes remote needs-input counts for the favicon and the logo', () => {
    ctl = api.start();
    ctl.switchTo('env1');
    const onWaiting = vi.fn();
    window.addEventListener('envsw:waiting', onWaiting);
    fromFrame(frameOf(ctl), { type: 'envsw:waiting', count: 3 });
    window.removeEventListener('envsw:waiting', onWaiting);
    expect(document.documentElement.dataset.envswWaiting).toBe('3');
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(logo().hasAttribute('data-envsw-alert')).toBe(true);
  });

  it('remembers the active env and its path for a reload', () => {
    ctl = api.start();
    ctl.switchTo('env1');
    fromFrame(frameOf(ctl), { type: 'envsw:path', path: '//evil.example.com' });
    fromFrame(frameOf(ctl), { type: 'envsw:path', path: '/session/42' });
    ctl.destroy();
    ctl = api.start();
    expect(ctl.active).toBe('env1');
    expect(frameOf(ctl).el.getAttribute('src')).toBe('https://m4.example.com/session/42');
  });

  it('switches with Ctrl+Option+digit', () => {
    ctl = api.start();
    const press = (code) => document.dispatchEvent(new KeyboardEvent('keydown', { code, ctrlKey: true, altKey: true, bubbles: true }));
    press('Digit2');
    expect(ctl.active).toBe('env1');
    press('Digit1');
    expect(ctl.active).toBeNull();
  });

  it('opens other envs in new tabs when this page is not a configured origin', () => {
    renderPage([{ name: 'M4', origin: 'https://m4.example.com' }]);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    ctl = api.start();
    expect(logo().getAttribute('data-envsw-label')).toBe('Local');
    ctl.switchToIndex(0);
    expect(open).toHaveBeenCalledWith('https://m4.example.com', '_blank', 'noopener');
    expect(ctl.frames.size).toBe(0);
  });

  it('shows a reload banner when its own Access session expired', async () => {
    fetch.mockResolvedValue({ type: 'opaqueredirect', status: 0 });
    ctl = api.start();
    await vi.waitFor(() => expect(document.getElementById('envsw-banner')).not.toBeNull());
    expect(document.getElementById('envsw-banner').textContent).toContain('Your sign-in to Dev expired.');
  });
});

describe('embedded mode', () => {
  it('says hello to the other configured origins and forwards logo clicks', () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    ctl = api.start({ framed: true });
    expect(ctl.mode).toBe('embedded');
    expect(post).toHaveBeenCalledWith({ type: 'envsw:hello' }, 'https://m4.example.com');
    expect(post).not.toHaveBeenCalledWith(expect.anything(), 'https://dev.example.com');
    logo().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'envsw:open-menu' }), 'https://m4.example.com');
    expect(document.querySelector('.envsw-menu')).toBeNull();
  });

  it('turns pushState into replaceState and reports the path', () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    ctl = api.start({ framed: true });
    const before = history.length;
    history.pushState(null, '', '/session/9');
    expect(history.length).toBe(before);
    expect(location.pathname).toBe('/session/9');
    expect(post).toHaveBeenCalledWith({ type: 'envsw:path', path: '/session/9' }, 'https://m4.example.com');
  });

  it('pins the host origin on init and ignores unknown origins', () => {
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    ctl = api.start({ framed: true });
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'envsw:peers', count: 2 }, origin: 'https://evil.example.com', source: window }));
    expect(logo().hasAttribute('data-envsw-alert')).toBe(false);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'envsw:init' }, origin: 'https://m4.example.com', source: window }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'envsw:peers', count: 2 }, origin: 'https://m4.example.com', source: window }));
    expect(logo().hasAttribute('data-envsw-alert')).toBe(true);
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'envsw:title' }), 'https://m4.example.com');
  });
});

describe('auth landing', () => {
  beforeEach(() => { vi.useFakeTimers(); }); // its delayed "you can close this window" banner must not leak

  it('strips the marker and returns only to a configured origin', () => {
    history.replaceState(null, '', '/?envsw=auth&return=https%3A%2F%2Fm4.example.com');
    const result = api.start();
    expect(result.mode).toBe('auth');
    expect(location.search).toBe('');
  });

  it('refuses an unknown return origin and carries on as the app', () => {
    history.replaceState(null, '', '/?envsw=auth&return=https%3A%2F%2Fevil.example.com');
    ctl = api.start();
    expect(ctl.mode).toBe('host');
    expect(location.search).toBe('');
  });
});
