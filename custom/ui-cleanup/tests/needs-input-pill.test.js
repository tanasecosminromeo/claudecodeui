import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// path, not new URL(): under jsdom the global URL is jsdom's, which fs doesn't accept
const SOURCE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cleanup.js'), 'utf8');

// Evaluates cleanup.js with the test hook set, so it exports its helpers instead of starting.
function loadCleanup() {
  globalThis.__UIC_TEST__ = {};
  new Function(SOURCE)();
  const api = globalThis.__UIC_TEST__;
  delete globalThis.__UIC_TEST__;
  return api;
}

// The workspace header as React renders it: a flex row with the title block and the tab strip.
const HEADER = `
  <header>
    <div class="row">
      <div class="title">Project</div>
      <div class="tabs-wrap"><div class="scroll">
        <div role="tablist" aria-label="Workspace views"><button role="tab">Chat</button></div>
      </div></div>
    </div>
  </header>`;

const row = (over = {}) => ({
  sessionId: 'claude-1', appSessionId: 'claude-1', state: 'waiting', entrypoint: 'cli',
  waitingFor: 'permission prompt', pending: null, title: 'demo', project: 'app', ...over,
});
const pill = () => document.getElementById('uic-alert');
const rectWide = () => ({ width: 300, height: 30, top: 0, left: 0, right: 300, bottom: 30, x: 0, y: 0, toJSON() {} });
const rectNarrow = () => ({ ...rectWide(), width: 80, right: 80 });

describe('needs-input pill placement', () => {
  let uic;
  beforeEach(() => {
    document.body.innerHTML = '';
    history.replaceState({}, '', '/');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(rectWide);
    uic = loadCleanup();
  });
  afterEach(() => {
    window.innerWidth = 1024;
  });

  it('sits in the workspace header row, just before the tab strip', () => {
    document.body.innerHTML = HEADER;
    uic.updateAlert([row()]);
    const p = pill();
    expect(p).not.toBeNull();
    expect(p.parentElement.className).toBe('row');
    expect(p.nextElementSibling.className).toBe('tabs-wrap');
    expect(p.classList.contains('uic-alert-inline')).toBe(true);
    expect(p.classList.contains('uic-alert-compact')).toBe(false);
  });

  it('falls back to the fixed top-right placement on the body when there is no tab bar', () => {
    document.body.innerHTML = '<main>no header here</main>';
    uic.updateAlert([row()]);
    const p = pill();
    expect(p.parentElement).toBe(document.body);
    expect(p.classList.contains('uic-alert-inline')).toBe(false);
  });

  it('re-attaches to the header after React replaces it', () => {
    document.body.innerHTML = HEADER;
    uic.updateAlert([row()]);
    const old = pill();
    document.body.innerHTML = `${HEADER}<div class="other"></div>`;
    uic.updateAlert([row()]);
    const p = pill();
    expect(p).not.toBe(old);
    expect(p.parentElement.className).toBe('row');
    expect(p.nextElementSibling.className).toBe('tabs-wrap');
    expect(document.querySelectorAll('#uic-alert').length).toBe(1);
  });

  it('moves out of the body into the header when the header appears later', () => {
    document.body.innerHTML = '<main></main>';
    uic.updateAlert([row()]);
    expect(pill().parentElement).toBe(document.body);
    document.body.insertAdjacentHTML('afterbegin', HEADER);
    uic.updateAlert([row()]);
    expect(pill().parentElement.className).toBe('row');
  });

  it('removes the pill when nothing waits and no other session is open', () => {
    document.body.innerHTML = HEADER;
    uic.updateAlert([row()]);
    uic.updateAlert([row({ state: 'idle' })]);
    expect(pill()).toBeNull();
  });
});

describe('needs-input pill compact mode', () => {
  let uic;
  beforeEach(() => {
    document.body.innerHTML = HEADER;
    history.replaceState({}, '', '/');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(rectWide);
    uic = loadCleanup();
  });
  afterEach(() => {
    window.innerWidth = 1024;
  });

  it('is off when the pill has room for its text', () => {
    uic.updateAlert([row({ title: 'Fix login' })]);
    expect(pill().classList.contains('uic-alert-compact')).toBe(false);
    expect(pill().querySelector('.uic-alert-text').textContent).toBe('Needs input: Fix login');
  });

  it('turns on when the pill would be under 120px, and keeps the aria-label', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(rectNarrow);
    uic.updateAlert([row({ title: 'Fix login' })]);
    const p = pill();
    expect(p.classList.contains('uic-alert-compact')).toBe(true);
    expect(p.getAttribute('aria-label')).toBe('Needs input: Fix login');
    expect(p.title).toContain('Fix login');
    expect(p.querySelector('.uic-alert-text')).not.toBeNull();
  });

  it('turns on for phone widths (<= 640px) even when the pill is wide', () => {
    window.innerWidth = 390;
    uic.updateAlert([row({ title: 'Fix login' })]);
    expect(pill().classList.contains('uic-alert-compact')).toBe(true);
    expect(pill().getAttribute('aria-label')).toBe('Needs input: Fix login');
  });

  it('keeps the +N count in compact mode', () => {
    window.innerWidth = 390;
    uic.updateAlert([row({ sessionId: 'a', appSessionId: 'a' }), row({ sessionId: 'b', appSessionId: 'b' })]);
    expect(pill().querySelector('.uic-alert-more').textContent).toBe(' +1');
  });
});
