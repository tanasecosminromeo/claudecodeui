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

const UNIT = 'cloudcli-claude-aaaaaaaa-1111-2222-3333-444444444444-AAAAAA.scope';
const proc = (pid, depth, name, command) => ({
  pid, ppid: depth ? 700 : 1, procStart: String(pid * 10), depth, name, command,
  startedAt: Date.now() - 600000, rssBytes: 5 * 1048576,
});
const group = (over = {}) => ({
  unit: UNIT, appSessionId: 'aaaaaaaa-1111-2222-3333-444444444444', title: 'Tunnel work', project: 'claudecodeui',
  startedAt: Date.now() - 3600000,
  processes: [proc(700, 0, 'sh', 'sh -c ./tunnel.sh'), proc(701, 1, 'node', 'node server.js --port 3000')],
  ...over,
});
const payload = (groups, serverStartedAt = 1001) => ({ serverStartedAt, groups });
const resp = (status, body) => ({ ok: status < 300, status, json: async () => body });
const btn = (label) => document.querySelector(`button[aria-label="${label}"]`);
const overlay = () => document.getElementById('uic-leftovers');
const items = () => document.querySelectorAll('.uic-lo-item');
const cta = () => document.querySelector('.uic-lo-cta');

describe('leftover processes modal', () => {
  let uic;
  beforeEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    localStorage.setItem('auth-token', 't');
    uic = loadCleanup();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the group and one indented row per process, with the full command as title', () => {
    uic.openLeftovers(payload([group()]));
    expect(overlay()).not.toBeNull();
    expect(overlay().getAttribute('role')).toBeNull(); // the role is on the card
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('.uic-lo-gname').textContent).toBe('Tunnel work');
    expect(items()).toHaveLength(2);
    expect(btn('Kill sh (pid 700)')).not.toBeNull();
    expect(btn('Kill node (pid 701)')).not.toBeNull();
    expect(document.querySelectorAll('.uic-lo-cmd')[1].title).toBe('node server.js --port 3000');
    expect(document.querySelectorAll('.uic-lo-row')[1].style.getPropertyValue('--depth')).toBe('1');
    expect(cta().textContent).toBe('Kill all (2)');
  });

  it('shows the empty state when opened from the Running view with nothing left', () => {
    uic.openLeftovers(payload([]));
    expect(document.querySelector('.uic-lo-empty')).not.toBeNull();
    expect(cta().disabled).toBe(true);
  });

  it('the X button kills that pid and removes only its row', async () => {
    const fetchMock = vi.fn(async () => resp(200, { term: [701], kill: [] }));
    vi.stubGlobal('fetch', fetchMock);
    uic.openLeftovers(payload([group()]));
    btn('Kill node (pid 701)').click();
    await vi.waitFor(() => expect(btn('Kill node (pid 701)')).toBeNull());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/plugins/session-radar/rpc/leftovers/kill');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ unit: UNIT, pid: 701, procStart: '7010' });
    expect(items()).toHaveLength(1);
    expect(btn('Kill sh (pid 700)')).not.toBeNull();
    expect(cta().textContent).toBe('Kill all (1)');
  });

  it('removes the group when its last process is killed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, { term: [], kill: [] })));
    uic.openLeftovers(payload([group()]));
    btn('Kill node (pid 701)').click();
    await vi.waitFor(() => expect(btn('Kill node (pid 701)')).toBeNull());
    btn('Kill sh (pid 700)').click();
    await vi.waitFor(() => expect(document.querySelector('.uic-lo-group')).toBeNull());
    expect(document.querySelector('.uic-lo-empty').textContent).toBe('No leftover processes.');
    expect(cta().disabled).toBe(true);
  });

  it('a failed kill keeps the row and shows the error inline', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(409, { error: 'stale pid: the process has changed' })));
    uic.openLeftovers(payload([group()]));
    btn('Kill node (pid 701)').click();
    const rowErr = () => btn('Kill node (pid 701)').closest('.uic-lo-item').querySelector('.uic-lo-rowerr');
    await vi.waitFor(() => expect(rowErr().hidden).toBe(false));
    expect(rowErr().textContent).toContain('stale pid');
    expect(items()).toHaveLength(2);
    expect(btn('Kill node (pid 701)').disabled).toBe(false);
  });

  it('Kill all posts { all: true } and then shows what is still running', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(resp(200, { term: [700, 701], kill: [] }))
      .mockResolvedValueOnce(resp(200, payload([], 1001)));
    vi.stubGlobal('fetch', fetchMock);
    uic.openLeftovers(payload([group()]));
    cta().click();
    await vi.waitFor(() => expect(document.querySelector('.uic-lo-empty')).not.toBeNull());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ all: true });
    expect(fetchMock.mock.calls[1][0]).toBe('/api/plugins/session-radar/rpc/leftovers');
    expect(items()).toHaveLength(0);
    expect(cta().disabled).toBe(true);
  });

  it('Kill all sends one request for a double tap and locks the row X buttons while it is in flight', async () => {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const fetchMock = vi.fn()
      .mockReturnValueOnce(pending)
      .mockResolvedValueOnce(resp(200, payload([], 1001)));
    vi.stubGlobal('fetch', fetchMock);
    uic.openLeftovers(payload([group()]));
    cta().click();
    cta().click();
    expect(cta().disabled).toBe(true);
    expect(btn('Kill sh (pid 700)').disabled).toBe(true);
    expect(btn('Kill node (pid 701)').disabled).toBe(true);
    btn('Kill node (pid 701)').click();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finish(resp(200, { term: [700, 701], kill: [] }));
    await vi.waitFor(() => expect(document.querySelector('.uic-lo-empty')).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ all: true });
  });

  it('Close stores the restart stamp and removes the modal', () => {
    uic.openLeftovers(payload([group()], 1234));
    document.querySelector('.uic-lo-close').click();
    expect(localStorage.getItem('uic-leftovers-seen')).toBe('1234');
    expect(overlay()).toBeNull();
  });

  it('Escape and a click on the backdrop also close it, storing the stamp', () => {
    uic.openLeftovers(payload([group()], 55));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlay()).toBeNull();
    expect(localStorage.getItem('uic-leftovers-seen')).toBe('55');
    uic.openLeftovers(payload([group()], 56));
    overlay().click(); // target is the backdrop itself
    expect(overlay()).toBeNull();
    expect(localStorage.getItem('uic-leftovers-seen')).toBe('56');
  });

  it('opens once per CloudCLI restart: not again for a stamp the user closed, but for a new one', async () => {
    localStorage.setItem('uic-leftovers-seen', '1234');
    const fetchMock = vi.fn(async () => resp(200, payload([group()], 1234)));
    vi.stubGlobal('fetch', fetchMock);
    await uic.checkLeftovers();
    expect(overlay()).toBeNull();
    fetchMock.mockImplementation(async () => resp(200, payload([group()], 5678)));
    await uic.checkLeftovers();
    expect(overlay()).not.toBeNull();
    document.querySelector('.uic-lo-close').click();
    expect(localStorage.getItem('uic-leftovers-seen')).toBe('5678');
    await uic.checkLeftovers();
    expect(overlay()).toBeNull();
  });

  it('does not open on a stamp the user has not seen when there are no leftovers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, payload([], 99))));
    await uic.checkLeftovers();
    expect(overlay()).toBeNull();
  });

  it('never opens by itself with the no-auto flag, but the Running view entry still opens it', async () => {
    localStorage.setItem('uic-leftovers-no-auto', '1');
    vi.stubGlobal('fetch', vi.fn(async () => resp(200, payload([group()], 4321))));
    await uic.checkLeftovers();
    expect(overlay()).toBeNull();
    uic.openLeftovers();
    expect(overlay()).not.toBeNull();
  });

  it('a failed check (server down) is silent and does not open the modal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(uic.checkLeftovers()).resolves.toBeUndefined();
    expect(overlay()).toBeNull();
  });
});
