import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderArtefacts } from '../index.js';

const now = Date.parse('2026-10-02T12:00:00Z');
const H = 3600e3;
const iso = (ms) => new Date(ms).toISOString();

const groups = [
  {
    id: 'sess-a', url: 'https://ex.test/share/sess-a/T/', separate: false, sessionId: 'sess-a',
    expiresAt: iso(now + 5 * H), expired: false,
    session: { title: 'Star colours', project: 'claudecodeui', status: 'busy', archived: false, lastMessage: 'All 41 tests pass', appSessionId: 'app-a' },
    items: [
      { title: 'E2E report', url: 'https://ex.test/share/sess-a/T/reports/r/index.html', kind: 'html', publishedAt: iso(now - 5 * 60e3) },
      { title: 'Plan', url: 'https://ex.test/share/sess-a/T/plan.md', kind: 'markdown', publishedAt: iso(now - 2 * H) },
    ],
  },
  {
    id: 'x-abcdefgh', url: 'https://ex.test/share/x-abcdefgh/U/', separate: true, sessionId: 'sess-b',
    expiresAt: iso(now - H), expired: true,
    session: { title: 'Old work', project: 'homelab', status: 'archived', archived: true, lastMessage: null, appSessionId: 'sess-b' },
    items: [{ title: 'Notes', url: 'https://ex.test/share/x-abcdefgh/U/notes.md', kind: 'markdown', publishedAt: iso(now - 30 * H) }],
  },
];

let handle;
afterEach(() => { handle?.destroy(); document.body.replaceChildren(); });

async function mount(overrides = {}) {
  const calls = { extend: [], expire: [], open: [], copy: [], session: [] };
  const opts = {
    fetchData: async () => ({ now, groups: structuredClone(groups) }),
    extend: async (id, by) => { calls.extend.push([id, by]); },
    expire: async (id) => { calls.expire.push(id); },
    openUrl: (url) => calls.open.push(url),
    openBlank: () => null,
    copy: async (url) => { calls.copy.push(url); },
    onOpenSession: (id) => calls.session.push(id),
    confirm: () => true,
    now: () => now,
    ...overrides,
  };
  const el = document.createElement('div');
  document.body.append(el);
  handle = renderArtefacts(el, opts);
  await new Promise((r) => setTimeout(r, 10));
  return { el, calls };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('renderArtefacts', () => {
  it('shows one group per share, in the order given, with items newest first', async () => {
    const { el } = await mount();
    const heads = [...el.querySelectorAll('.sa-group .sa-title')].map((n) => n.textContent);
    expect(heads).toEqual(['Star colours', 'Old work']);
    const rows = [...el.querySelectorAll('.sa-group')[0].querySelectorAll('.sa-row .sa-row-title')].map((n) => n.textContent);
    expect(rows).toEqual(['E2E report', 'Plan']);
    expect(el.querySelector('.sa-group .sa-age').textContent).toBe('5m');
  });

  it('shows status badge, project, last message and expiry', async () => {
    const { el } = await mount();
    const [a, b] = el.querySelectorAll('.sa-group');
    expect(a.querySelector('.sa-badge').textContent).toBe('busy');
    expect(a.querySelector('.sa-project').textContent).toBe('claudecodeui');
    expect(a.querySelector('.sa-last').textContent).toBe('All 41 tests pass');
    expect(a.querySelector('.sa-exp').textContent).toMatch(/until \d{2}:\d{2} EES?T|until .* EES?T/);
    expect(b.querySelector('.sa-badge').textContent).toBe('archived');
    expect(b.querySelector('.sa-exp').textContent).toBe('expired');
    expect(b.querySelector('.sa-tag').textContent).toBe('separate');
    expect(b.querySelector('.sa-last')).toBeNull();
  });

  it('opens a live item in a new tab', async () => {
    const { el, calls } = await mount();
    el.querySelector('.sa-row').click();
    expect(calls.open).toEqual(['https://ex.test/share/sess-a/T/reports/r/index.html']);
  });

  it('dims expired items and offers to extend before opening', async () => {
    const confirm = vi.fn(() => true);
    const { el, calls } = await mount({ confirm });
    const row = el.querySelectorAll('.sa-group')[1].querySelector('.sa-row');
    expect(row.classList.contains('sa-expired')).toBe(true);
    row.click();
    await tick();
    expect(confirm).toHaveBeenCalledWith('Link expired: extend 24h and open?');
    expect(calls.extend).toEqual([['x-abcdefgh', '24h']]);
    expect(calls.open).toEqual(['https://ex.test/share/x-abcdefgh/U/notes.md']);
  });

  it('does nothing when the extend offer is declined', async () => {
    const { el, calls } = await mount({ confirm: () => false });
    el.querySelectorAll('.sa-group')[1].querySelector('.sa-row').click();
    await tick();
    expect(calls.extend).toEqual([]);
    expect(calls.open).toEqual([]);
  });

  it('wires the group buttons to the share and to the app session', async () => {
    const { el, calls } = await mount();
    const a = el.querySelector('.sa-group');
    a.querySelector('[data-act="copy"]').click();
    a.querySelector('[data-act="extend"]').click();
    a.querySelector('[data-act="expire"]').click();
    a.querySelector('[data-act="session"]').click();
    await tick();
    expect(calls.copy).toEqual(['https://ex.test/share/sess-a/T/']);
    expect(calls.extend).toEqual([['sess-a', '24h']]);
    expect(calls.expire).toEqual(['sess-a']);
    expect(calls.session).toEqual(['app-a']);
  });

  it('filters by item title and keeps the matching group', async () => {
    const { el } = await mount();
    handle.setFilter('e2e');
    expect([...el.querySelectorAll('.sa-group .sa-title')].map((n) => n.textContent)).toEqual(['Star colours']);
    expect([...el.querySelectorAll('.sa-row-title')].map((n) => n.textContent)).toEqual(['E2E report']);
  });

  it('keeps every item of a group whose session, project or last message matches', async () => {
    const { el } = await mount();
    handle.setFilter('HOMELAB');
    expect([...el.querySelectorAll('.sa-group .sa-title')].map((n) => n.textContent)).toEqual(['Old work']);
    handle.setFilter('41 tests');
    expect(el.querySelectorAll('.sa-row').length).toBe(2);
  });

  it('says when nothing matches, and shows everything again when cleared', async () => {
    const { el } = await mount();
    handle.setFilter('zzz');
    expect(el.querySelector('.sa-empty').textContent).toBe('No artefacts match "zzz".');
    handle.setFilter('  ');
    expect(el.querySelectorAll('.sa-group').length).toBe(2);
  });

  it('keeps the filter across refreshes', async () => {
    const { el } = await mount();
    handle.setFilter('plan');
    await handle.refresh();
    expect([...el.querySelectorAll('.sa-row-title')].map((n) => n.textContent)).toEqual(['Plan']);
  });

  it('says how to publish when there is nothing yet', async () => {
    const { el } = await mount({ fetchData: async () => ({ now, groups: [] }) });
    expect(el.querySelector('.sa-empty').textContent).toMatch(/publish/i);
  });

  it('shows an error when loading fails', async () => {
    const { el } = await mount({ fetchData: async () => { throw new Error('HTTP 502'); } });
    expect(el.querySelector('.sa-error').textContent).toContain('HTTP 502');
  });
});
