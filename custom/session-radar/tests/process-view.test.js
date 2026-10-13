import { afterEach, describe, expect, it } from 'vitest';
import { renderRadar } from '../index.js';

// The Running view's chevron, the activity lines under a row, and the process modal.
const now = Date.now();
const T = now - 60000;
const busy = {
  sessionId: 'a', title: 'Busy one', cwd: '/w/p', project: 'p', lastMessage: now - 60000, tasks: 1, agents: 1,
  state: 'busy', live: true, pids: [1], rssMb: 300, procs: 3, branch: 'main', model: 'claude-sonnet-5-5',
  activity: {
    agents: [{ description: 'Audit the radar masking', startedAt: now - 3 * 60000 }],
    tasks: [{ description: 'Watch the build log', startedAt: now - 12 * 60000 }],
    current: 'npm test -- process-view',
    recent: ['curl https://example.com/a', 'git status', 'npm run lint'],
  },
};
const idle = { sessionId: 'b', title: 'Idle one', cwd: '/w/q', project: 'q', lastMessage: now - 60000, tasks: 0, agents: 0, state: 'idle', live: true, pids: [2], rssMb: 10, procs: 1 };
const sessions = [busy, idle];

const tree = {
  now, history: true, roots: [1], truncated: 0,
  nodes: [
    { pid: 1, procStart: '100000', parent: null, root: 1, argv: 'claude', cmd: 'claude', live: true, rssKb: 204800, startMs: T, endMs: null, code: null, sig: null },
    { pid: 11, procStart: '110000', parent: 1, root: 1, argv: 'zsh -c sleep 600', cmd: 'sleep 600', live: true, rssKb: 1024, startMs: T + 10, endMs: null, code: null, sig: null },
    { pid: 12, procStart: undefined, parent: 1, root: 1, argv: 'zsh -c make test', cmd: 'make test', live: false, rssKb: 0, startMs: T + 20, endMs: T + 1520, code: 2, sig: 0 },
  ],
};

const detail = (over = {}) => ({
  now, pid: 1, procStart: '100000', name: 'claude', ppid: 0, command: 'claude --model claude-sonnet-5-5 --token •••',
  cwd: '/w/p', startedAt: T, ageMs: 60000, state: 'S', threads: 9, rssBytes: 209715200,
  cpu: { seconds: 80, percent: 0.1 }, scope: { unit: 'session.scope', kind: 'session' }, killable: false,
  children: [{ pid: 11, procStart: '110000', name: 'sleep', command: 'sleep 600' }],
  history: [{ ts: T + 1000, pid: 11, cmd: 'npm test', endMs: T + 2000, code: 2, sig: 0, status: 'exit 2' }],
  historyTotal: 1, historyAvailable: true, ...over,
});

let handle = null;
afterEach(() => { handle?.destroy(); handle = null; localStorage.clear(); document.body.replaceChildren(); });

const tick = () => new Promise((r) => setTimeout(r, 20));

async function mount({ fetchProcess, killLeftover, treeData = tree, rows = sessions } = {}) {
  const el = document.createElement('div');
  document.body.append(el);
  const calls = { process: [], kill: [] };
  handle = renderRadar(el, {
    fetchData: async () => ({ now, sessions: rows, machine: { cpus: 8, load: [0.5, 0.4, 0.3], memTotalMb: 16384, memAvailMb: 8192 } }),
    stopSession: async () => {},
    fetchTree: async () => treeData,
    fetchProcess: fetchProcess || (async (pid, procStart) => { calls.process.push([pid, procStart]); return detail({ pid, procStart }); }),
    killLeftover: killLeftover || (async (body) => { calls.kill.push(body); }),
    onOpen: () => {},
  });
  await tick();
  return { el, calls };
}

const modal = () => document.querySelector('.sr-pm-overlay');
const modalButton = (text) => [...document.querySelectorAll('.sr-pm-overlay button')].find((b) => b.textContent === text);

describe('chevron', () => {
  it('toggles the tree with aria-expanded and a 32px hit area, and leaves the row click alone', async () => {
    const { el } = await mount();
    const chev = el.querySelector('.sr-busy .sr-chev');
    expect(chev.getAttribute('aria-expanded')).toBe('false');
    expect(chev.textContent).toBe('▸');
    chev.click();
    await tick();
    const open = el.querySelector('.sr-busy .sr-chev');
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(open.textContent).toBe('▾');
    expect(el.querySelectorAll('.sr-tree').length).toBe(1);
    open.click();
    await tick();
    expect(el.querySelector('.sr-busy .sr-chev').getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelectorAll('.sr-tree').length).toBe(0);
  });

  it('a row click opens the session, not the tree', async () => {
    const opened = [];
    const el = document.createElement('div');
    document.body.append(el);
    handle = renderRadar(el, {
      fetchData: async () => ({ now, sessions, machine: null }), stopSession: async () => {},
      fetchTree: async () => tree, onOpen: (id) => opened.push(id),
    });
    await tick();
    el.querySelector('.sr-busy .sr-title').click();
    expect(opened).toEqual(['a']);
    expect(el.querySelectorAll('.sr-tree').length).toBe(0);
  });
});

describe('process lines', () => {
  it('a live line is a focusable button; a finished one is not', async () => {
    const { el } = await mount();
    el.querySelector('.sr-busy .sr-chev').click();
    await tick();
    const lines = el.querySelectorAll('.sr-node.sr-live');
    expect(lines.length).toBe(2); // claude and sleep: the make test line has ended
    expect(lines[0].getAttribute('role')).toBe('button');
    expect(lines[0].tabIndex).toBe(0);
    expect(el.querySelectorAll('.sr-node.sr-dead.sr-live').length).toBe(0);
  });

  it('a click opens the process modal with the fetched data', async () => {
    const { el, calls } = await mount();
    el.querySelector('.sr-busy .sr-chev').click();
    await tick();
    el.querySelector('.sr-node.sr-live .sr-cmd').click();
    await tick();
    expect(calls.process).toEqual([[1, '100000']]);
    expect(modal()).not.toBeNull();
    expect(document.querySelector('.sr-pm-title').textContent).toBe('claude');
    expect(document.querySelector('.sr-pm-cmd').textContent).toBe('claude --model claude-sonnet-5-5 --token •••');
    expect(document.querySelector('.sr-pm-card').getAttribute('role')).toBe('dialog');
    expect(modalButton('Close')).toBeDefined();
    expect(modalButton('Kill').hidden).toBe(true); // no kill button on a session process
  });

  it('Enter on a focused line opens the modal too', async () => {
    const { el } = await mount();
    el.querySelector('.sr-busy .sr-chev').click();
    await tick();
    const line = el.querySelector('.sr-node.sr-live');
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    expect(modal()).not.toBeNull();
  });

  it('a stale or gone process shows a message instead of data', async () => {
    const { el } = await mount({
      fetchProcess: async () => { throw Object.assign(new Error('gone'), { status: 404 }); },
    });
    el.querySelector('.sr-busy .sr-chev').click();
    await tick();
    el.querySelector('.sr-node.sr-live .sr-cmd').click();
    await tick();
    expect(document.querySelector('.sr-pm-body').textContent).toContain('This process has ended');
  });

  it('child link opens that child in the same modal, and Back returns to the parent', async () => {
    const seen = [];
    const { el } = await mount({
      fetchProcess: async (pid, procStart) => {
        seen.push(pid);
        return pid === 1 ? detail() : detail({ pid: 11, procStart: '110000', name: 'sleep', command: 'sleep 600', children: [], history: [], historyTotal: 0, ppid: 1, scope: { unit: 'session.scope', kind: 'session' } });
      },
    });
    el.querySelector('.sr-busy .sr-chev').click();
    await tick();
    el.querySelector('.sr-node.sr-live .sr-cmd').click();
    await tick();
    expect(modalButton('← Back').hidden).toBe(true); // nothing to go back to yet
    document.querySelector('.sr-pm-link').click();
    await tick();
    expect(seen).toEqual([1, 11]);
    expect(document.querySelector('.sr-pm-title').textContent).toBe('sleep');
    expect(modalButton('← Back').hidden).toBe(false);
    modalButton('← Back').click();
    await tick();
    expect(seen).toEqual([1, 11, 1]);
    expect(document.querySelector('.sr-pm-title').textContent).toBe('claude');
  });

  it('Kill shows only for a leftover scope, and needs a second click', async () => {
    const leftover = detail({ scope: { unit: 'cloudcli-claude-aaaaaaaa-1111-2222-3333-444444444444-AAAAAA.scope', kind: 'leftover' }, killable: true });
    const { el, calls } = await mount({ fetchProcess: async () => leftover });
    el.querySelector('.sr-busy .sr-chev').click();
    await tick();
    el.querySelector('.sr-node.sr-live .sr-cmd').click();
    await tick();
    const kill = modalButton('Kill');
    expect(kill).toBeDefined();
    expect(kill.hidden).toBe(false);
    kill.click();
    await tick();
    expect(calls.kill).toEqual([]); // first click only arms it
    expect(modalButton('Click again to kill')).toBeDefined();
    modalButton('Click again to kill').click();
    await tick();
    expect(calls.kill).toEqual([{ unit: leftover.scope.unit, pid: 1, procStart: '100000' }]);
    expect(modal()).toBeNull(); // the modal closes once the process is killed
  });

  it('Esc closes the modal; the backdrop and × close it too', async () => {
    const { el } = await mount();
    el.querySelector('.sr-busy .sr-chev').click();
    await tick();
    el.querySelector('.sr-node.sr-live .sr-cmd').click();
    await tick();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal()).toBeNull();
    el.querySelector('.sr-node.sr-live .sr-cmd').click();
    await tick();
    document.querySelector('.sr-pm-x').click();
    expect(modal()).toBeNull();
    el.querySelector('.sr-node.sr-live .sr-cmd').click();
    await tick();
    modal().click(); // the backdrop itself, not the card
    expect(modal()).toBeNull();
  });
});

describe('activity lines', () => {
  it('a running row shows its agents, tasks, the current command and recent commands', async () => {
    const { el } = await mount();
    const lines = [...el.querySelectorAll('.sr-busy .sr-act')];
    expect(lines.length).toBe(4);
    expect(lines[0].textContent).toBe('agent: Audit the radar masking · 3m');
    expect(lines[1].textContent).toBe('task: Watch the build log · 12m');
    expect(lines[2].textContent).toBe('$ npm test -- process-view');
    expect(lines[3].textContent).toBe('recent: curl https://example.com/a, git status, npm run lint');
    expect(lines[0].title).toBe(lines[0].textContent);
  });

  it('shows at most four lines and nothing for an idle row', async () => {
    const many = {
      ...busy,
      activity: { agents: [1, 2, 3].map((i) => ({ description: `agent ${i}`, startedAt: now - 60000 })), tasks: [{ description: 'task', startedAt: null }], current: 'ls', recent: [] },
    };
    const { el } = await mount({ rows: [many, { ...idle, activity: busy.activity }] });
    expect(el.querySelectorAll('.sr-busy .sr-act').length).toBe(4);
    expect(el.querySelectorAll('.sr-idle .sr-act').length).toBe(0);
  });

  it('a long line keeps its full text in the title (the CSS cuts it with an ellipsis)', async () => {
    const long = 'x'.repeat(300);
    const { el } = await mount({ rows: [{ ...busy, activity: { agents: [{ description: long, startedAt: now }], tasks: [], current: null, recent: [] } }] });
    const line = el.querySelector('.sr-busy .sr-act');
    expect(line.textContent.length).toBeGreaterThan(300);
    expect(line.title).toBe(line.textContent);
  });
});
