import { afterEach, describe, expect, it } from 'vitest';
import { renderRadar } from '../index.js';

const now = Date.now();
const base = { cwd: '/w/p', project: 'p', lastMessage: now - 60000, tasks: 0 };
const sessions = [
  { ...base, sessionId: 'a', title: 'Busy one', state: 'busy', live: true, pids: [1], rssMb: 300, procs: 3, agents: 1, branch: 'main', model: 'claude-sonnet-5-5', contextTokens: 120000 },
  { ...base, sessionId: 'b', title: 'Idle one', state: 'idle', live: true, pids: [2], rssMb: 1200, procs: 2, agents: 0 },
  { ...base, sessionId: 'c', title: 'Old one', state: 'ended', live: false, pids: [] },
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
    expect(stats).toEqual(['2', '1.5 GB', '1', '8.0 GB/16.0 GB', '0.5/8']);
    expect(el.querySelector('.sr-busy').title).toContain('context 120k tokens');
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
