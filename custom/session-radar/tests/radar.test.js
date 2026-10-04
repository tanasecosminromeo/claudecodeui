import { afterEach, describe, expect, it } from 'vitest';
import { renderRadar } from '../index.js';

const now = Date.now();
const base = { cwd: '/w/p', project: 'p', lastMessage: now - 60000, tasks: 0 };
const sessions = [
  { ...base, sessionId: 'a', title: 'Busy one', state: 'busy', live: true, pids: [1], rssMb: 300, procs: 3, agents: 1, branch: 'main', model: 'claude-sonnet-5-5', contextTokens: 120000 },
  { ...base, sessionId: 'b', title: 'Idle one', state: 'idle', live: true, pids: [2], rssMb: 1200, procs: 2, agents: 0 },
  { ...base, sessionId: 'c', title: 'Old one', state: 'ended', live: false, pids: [] },
  { ...base, sessionId: 'pid:777', title: 'claude --chrome-native-host', state: 'other', other: true, live: true, pids: [777], rssMb: 50, procs: 1, agents: 0 },
];

let handle;
const stopped = [];
const stopSession = async (id) => { stopped.push(id); };
afterEach(() => { handle?.destroy(); localStorage.clear(); document.body.replaceChildren(); });

async function mount() {
  const el = document.createElement('div');
  document.body.append(el);
  handle = renderRadar(el, { fetchData: async () => ({ now, sessions, machine: { cpus: 8, load: [0.5, 0.4, 0.3], memTotalMb: 16384, memAvailMb: 8192 } }), stopSession });
  await new Promise((r) => setTimeout(r, 20));
  return el;
}

describe('renderRadar', () => {
  it('summarises live sessions and shows memory, agents and branch on their rows', async () => {
    const el = await mount();
    const meta = el.querySelector('.sr-busy .sr-meta').textContent;
    expect(meta).toContain('300 MB');
    expect(meta).toContain('1 agent');
    expect(meta).toContain('main');
    const stats = [...el.querySelectorAll('.sr-summary .sr-stat')].map((n) => n.textContent);
    expect(el.querySelectorAll('.sr-summary').length).toBe(1);
    expect(stats).toEqual(['2', '1.5 GB', '1', '8.0 GB/16.0 GB', '0.5/8']); // the other-process row counts in neither
    expect(el.querySelector('.sr-busy').title).toContain('context 120k tokens');
    expect(el.querySelector('.sr-row.sr-other')).not.toBeNull();
    expect(el.querySelector('.sr-row.sr-other .sr-more')).toBeNull(); // no options menu on an other-process row
  });

  it('keeps ended sessions collapsed until the group is opened, and remembers it', async () => {
    let el = await mount();
    expect(el.querySelectorAll('.sr-row.sr-ended').length).toBe(0);
    const toggle = el.querySelector('.sr-toggle');
    expect(toggle.textContent).toContain('Ended');
    toggle.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el.querySelectorAll('.sr-row.sr-ended').length).toBe(1);
    handle.destroy();
    el = await mount();
    expect(el.querySelectorAll('.sr-row.sr-ended').length).toBe(1);
  });

  it('stops a live session only after a second click, and not an ended one', async () => {
    const el = await mount();
    const menuItems = async (row) => {
      row.querySelector('.sr-more').click();
      await new Promise((r) => setTimeout(r, 5));
      return [...document.querySelectorAll('.sr-menu .sr-item')];
    };
    const stop = (await menuItems(el.querySelector('.sr-busy'))).find((b) => b.textContent.startsWith('Stop session'));
    stop.click();
    expect(stopped).toEqual([]);
    expect(stop.textContent).toContain('Click again');
    stop.click();
    await new Promise((r) => setTimeout(r, 5));
    expect(stopped).toEqual(['a']);
  });
});

describe('process tree', () => {
  const T = Date.now() - 60000;
  const tree = {
    now: Date.now(), history: true, roots: [1], truncated: 0,
    nodes: [
      { pid: 1, parent: null, root: 1, argv: 'claude', cmd: 'claude', live: true, rssKb: 204800, startMs: T, endMs: null, code: null, sig: null },
      { pid: 11, parent: 1, root: 1, argv: 'zsh -c sleep 600', cmd: 'sleep 600', live: true, rssKb: 1024, startMs: T + 10, endMs: null, code: null, sig: null },
      { pid: 12, parent: 1, root: 1, argv: 'zsh -c make test', cmd: 'make test', live: false, rssKb: 0, startMs: T + 20, endMs: T + 1520, code: 2, sig: 0 },
      { pid: 13, parent: 12, root: 1, argv: 'node vitest', cmd: 'node vitest', live: false, rssKb: 0, startMs: T + 30, endMs: T + 1500, code: 0, sig: 0 },
    ],
  };
  let fetched = [];
  let opened = [];
  async function mountTree(treeData = tree) {
    const el = document.createElement('div');
    document.body.append(el);
    opened = []; fetched = [];
    handle = renderRadar(el, {
      fetchData: async () => ({ now, sessions, machine: { cpus: 8, load: [0.5, 0.4, 0.3], memTotalMb: 16384, memAvailMb: 8192 } }),
      stopSession,
      fetchTree: async (sid) => { fetched.push(sid); return treeData; },
      onOpen: (id) => opened.push(id),
    });
    await new Promise((r) => setTimeout(r, 20));
    return el;
  }

  it('expands a live row into its tree; finished branches start collapsed, failures are marked', async () => {
    const el = await mountTree();
    expect(el.querySelectorAll('.sr-row.sr-ended .sr-chev').length).toBe(0);
    const chev = el.querySelector('.sr-row.sr-busy .sr-chev');
    chev.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual([]); // the chevron does not open the session
    expect(fetched).toEqual(['a']);
    const treeEl = el.querySelector('.sr-tree[data-sid="a"]');
    const cmds = [...treeEl.querySelectorAll('.sr-node .sr-cmd')].map((n) => n.textContent);
    expect(cmds).toEqual(['claude', 'sleep 600', 'make test']); // 13 hidden under the collapsed finished node 12
    const dead = treeEl.querySelector('.sr-node.sr-dead.sr-fail');
    expect(dead.querySelector('.sr-nmeta').textContent).toContain('exit 2');
    expect(dead.title).toContain('pid 12');
    expect(treeEl.querySelector('.sr-node:not(.sr-dead) .sr-nmeta').textContent).toContain('200 MB');
    dead.querySelector('.sr-node-chev').click();
    await new Promise((r) => setTimeout(r, 5));
    expect([...el.querySelectorAll('.sr-tree .sr-cmd')].map((n) => n.textContent)).toContain('node vitest');
  });

  it('keeps the tree open across a list redraw and remembers it', async () => {
    let el = await mountTree();
    el.querySelector('.sr-row.sr-busy .sr-chev').click();
    await new Promise((r) => setTimeout(r, 20));
    handle.refresh(); // forces a full redraw of the list
    await new Promise((r) => setTimeout(r, 20));
    expect(el.querySelector('.sr-tree[data-sid="a"] .sr-node')).not.toBeNull();
    expect(el.querySelector('.sr-row.sr-busy .sr-chev').getAttribute('aria-expanded')).toBe('true');
    handle.destroy();
    el = await mountTree();
    expect(el.querySelector('.sr-tree[data-sid="a"] .sr-node')).not.toBeNull();
    el.querySelector('.sr-row.sr-busy .sr-chev').click();
    await new Promise((r) => setTimeout(r, 5));
    expect(el.querySelector('.sr-tree[data-sid="a"]')).toBeNull();
  });

  it('says when history is unavailable', async () => {
    const el = await mountTree({ ...tree, history: false, nodes: tree.nodes.filter((n) => n.live) });
    el.querySelector('.sr-row.sr-busy .sr-chev').click();
    await new Promise((r) => setTimeout(r, 20));
    expect(el.querySelector('.sr-tree-note').textContent).toContain('make exec-tracer');
  });
});
