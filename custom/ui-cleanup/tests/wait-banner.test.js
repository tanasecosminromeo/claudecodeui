import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

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

const row = (over = {}) => ({
  sessionId: 'claude-1', appSessionId: 'claude-1', state: 'waiting', entrypoint: 'cli',
  waitingFor: 'permission prompt', pending: { tool: 'Bash', summary: 'touch /tmp/x.txt' }, title: 'demo', ...over,
});
const banner = () => document.querySelector('[data-uic-wait-banner]');

describe('waiting-in-a-terminal banner', () => {
  let uic;
  beforeEach(() => {
    document.body.innerHTML = '<div class="chat-composer-shell"><div class="form-wrap"><form></form></div></div>';
    history.replaceState({}, '', '/session/claude-1');
    uic = loadCleanup();
  });

  it('shows what the open terminal session waits for, above the composer', () => {
    uic.updateAlert([row()]);
    const b = banner();
    expect(b).not.toBeNull();
    expect(b.parentElement.className).toBe('chat-composer-shell');
    expect(b.parentElement.firstElementChild).toBe(b);
    expect(b.textContent).toContain('Waiting in a terminal: permission prompt');
    expect(b.textContent).toContain('Bash');
    expect(b.textContent).toContain('touch /tmp/x.txt');
    expect(b.textContent).toContain('take the session over');
  });

  it('matches the open session by its CloudCLI id or by Claude\'s id', () => {
    uic.updateAlert([row({ appSessionId: 'app-9' })]);
    expect(banner()).not.toBeNull();
    history.replaceState({}, '', '/session/app-9');
    uic.renderWaitBanner();
    expect(banner()).not.toBeNull();
  });

  it('stays away for chats CloudCLI runs, other sessions and sessions not waiting', () => {
    uic.updateAlert([row({ entrypoint: 'sdk-ts' })]);
    expect(banner()).toBeNull();
    uic.updateAlert([row({ sessionId: 'other', appSessionId: 'other' })]);
    expect(banner()).toBeNull();
    uic.updateAlert([row({ state: 'busy' })]);
    expect(banner()).toBeNull();
  });

  it('updates in place and goes away once the prompt is answered', () => {
    uic.updateAlert([row()]);
    const first = banner();
    uic.updateAlert([row({ pending: { tool: 'Edit', summary: '/w/a.js' } })]);
    expect(banner()).toBe(first);
    expect(first.textContent).toContain('/w/a.js');
    uic.updateAlert([row({ state: 'idle' })]);
    expect(banner()).toBeNull();
  });

  it('works without a pending request and comes back when React replaces the composer', () => {
    uic.updateAlert([row({ pending: null, waitingFor: null })]);
    expect(banner().textContent).toContain('Waiting in a terminal: your input');
    document.body.innerHTML = '<div class="chat-composer-shell"><form></form></div>';
    uic.renderWaitBanner();
    expect(banner()).not.toBeNull();
  });

  it('leaves the DOM alone when nothing changed (it runs on every DOM change)', async () => {
    uic.updateAlert([row()]);
    const records = [];
    const obs = new MutationObserver((r) => records.push(...r));
    obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    uic.renderWaitBanner();
    uic.updateAlert([row()]);
    await Promise.resolve();
    obs.disconnect();
    expect(records).toEqual([]);
  });
});
