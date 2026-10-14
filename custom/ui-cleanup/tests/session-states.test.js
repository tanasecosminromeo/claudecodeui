import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  sessionId: 'provider-1', appSessionId: 'app-1', state: 'waiting', entrypoint: 'cli',
  waitingFor: 'permission prompt', pending: null, title: 'demo', project: 'app', ...over,
});

describe('session states published to the React sidebar', () => {
  let uic;
  let onWaiting;

  beforeEach(() => {
    delete document.documentElement.dataset.uicWaiting;
    delete window.__uicSessionStates;
    history.replaceState({}, '', '/');
    uic = loadCleanup();
    onWaiting = vi.fn();
    window.addEventListener('uic:waiting', onWaiting);
  });

  it('publishes sorted waiting and busy ids, using appSessionId before sessionId', () => {
    uic.updateAlert([
      row({ appSessionId: 'zeta' }),
      row({ appSessionId: 'alpha', sessionId: 'p-2' }),
      row({ appSessionId: undefined, sessionId: 'p-3', state: 'busy' }),
      row({ state: 'idle', appSessionId: 'quiet' }),
    ]);
    expect(window.__uicSessionStates).toEqual({ waiting: ['alpha', 'zeta'], busy: ['p-3'] });
  });

  it('carries the id lists in the uic:waiting detail', () => {
    uic.updateAlert([row({ appSessionId: 'a1' })]);
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onWaiting.mock.calls[0][0].detail).toEqual({ count: 1, waiting: ['a1'], busy: [] });
  });

  it('fires again when the waiting ids change but the count stays the same', () => {
    uic.updateAlert([row({ appSessionId: 'a1' })]);
    uic.updateAlert([row({ appSessionId: 'b2' })]);
    expect(onWaiting).toHaveBeenCalledTimes(2);
    expect(onWaiting.mock.calls[1][0].detail).toEqual({ count: 1, waiting: ['b2'], busy: [] });
    expect(document.documentElement.dataset.uicWaiting).toBe('1');
  });

  it('fires when a session turns busy at the same waiting count', () => {
    uic.updateAlert([row({ appSessionId: 'a1' }), row({ appSessionId: 'b2', state: 'busy' })]);
    uic.updateAlert([row({ appSessionId: 'a1' }), row({ appSessionId: 'b2', state: 'idle' })]);
    expect(onWaiting).toHaveBeenCalledTimes(2);
    expect(onWaiting.mock.calls[1][0].detail).toEqual({ count: 1, waiting: ['a1'], busy: [] });
  });

  it('does not fire when nothing changed between radar polls', () => {
    const sessions = [row({ appSessionId: 'a1' }), row({ appSessionId: 'b2', state: 'busy' })];
    uic.updateAlert(sessions);
    uic.updateAlert(sessions.map((s) => ({ ...s })));
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });

  it('does not fire for changes that leave every id list and the count alone', () => {
    uic.updateAlert([row({ appSessionId: 'a1' }), row({ appSessionId: 'idle-1', state: 'idle' })]);
    uic.updateAlert([row({ appSessionId: 'a1' }), row({ appSessionId: 'idle-1', state: 'ended' })]);
    expect(onWaiting).toHaveBeenCalledTimes(1);
  });
});
