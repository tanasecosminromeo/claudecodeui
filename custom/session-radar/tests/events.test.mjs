// @vitest-environment node
import { expect, it as test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { procStartOf } from '../detail.mjs';
import {
  EventLog, FINISH_MIN_MS, aggregateStates, createStatusWatcher, decideStatusEvent, findTranscript, lastAssistantEntry, nextTracked, readStatusRecords,
} from '../events.mjs';

const none = () => null;

test('needs input fires on entering waiting, once', () => {
  const ev = decideStatusEvent({ state: 'busy', busySince: 0 }, { state: 'waiting', waitingFor: 'permission prompt' }, 1000, none);
  expect(ev).toEqual({ kind: 'action_required', code: 'session.waiting', meta: { waitingFor: 'permission prompt' } });
  expect(decideStatusEvent({ state: 'waiting', busySince: 0 }, { state: 'waiting' }, 2000, none)).toBeNull();
});

test('a new session that appears already waiting fires', () => {
  expect(decideStatusEvent(undefined, { state: 'waiting', waitingFor: null }, 0, none)?.code).toBe('session.waiting');
});

test('finished fires only for turns of 3 minutes or more', () => {
  const prev = { state: 'busy', busySince: 0 };
  expect(decideStatusEvent(prev, { state: 'idle' }, FINISH_MIN_MS - 1, none)).toBeNull();
  expect(decideStatusEvent(prev, { state: 'idle' }, 12 * 60 * 1000, none))
    .toEqual({ kind: 'stop', code: 'run.stopped', meta: { stopReason: 'Finished after 12 min' } });
});

test('an API error fires failed whatever the turn length', () => {
  const ev = decideStatusEvent({ state: 'busy', busySince: 0 }, { state: 'idle' }, 5000, () => ({ isApiError: true, text: 'Rate limit reached' }));
  expect(ev).toEqual({ kind: 'error', code: 'run.failed', meta: { error: 'Rate limit reached' } });
});

test('a turn interrupted by a prompt counts from its first busy', () => {
  let t = nextTracked(undefined, { state: 'busy' }, 0);
  t = nextTracked(t, { state: 'waiting' }, 60000);
  t = nextTracked(t, { state: 'busy' }, 120000);
  expect(t.busySince).toBe(0);
  expect(decideStatusEvent(t, { state: 'idle' }, FINISH_MIN_MS, none)?.code).toBe('run.stopped');
  expect(nextTracked(t, { state: 'idle' }, FINISH_MIN_MS).busySince).toBeNull();
});

test('idle to idle and busy to busy are silent', () => {
  expect(decideStatusEvent({ state: 'idle', busySince: null }, { state: 'idle' }, 1e9, none)).toBeNull();
  expect(decideStatusEvent({ state: 'busy', busySince: 0 }, { state: 'busy' }, 1e9, none)).toBeNull();
});

test('lastAssistantEntry reads the last main-thread assistant line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-ev-'));
  const file = path.join(dir, 's.jsonl');
  const lines = [
    { type: 'assistant', isApiErrorMessage: false, message: { content: [{ type: 'text', text: 'ok' }] } },
    { type: 'assistant', isApiErrorMessage: true, message: { content: [{ type: 'text', text: 'API Error: overloaded' }] } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } },
    { type: 'user', message: { content: 'x' } },
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  expect(lastAssistantEntry(file)).toEqual({ isApiError: true, text: 'API Error: overloaded' });
  expect(lastAssistantEntry(null)).toBeNull();
  expect(lastAssistantEntry(path.join(dir, 'missing.jsonl'))).toBeNull();
  fs.mkdirSync(path.join(dir, 'proj'));
  fs.writeFileSync(path.join(dir, 'proj', 'abc.jsonl'), '');
  expect(findTranscript(dir, 'abc')).toBe(path.join(dir, 'proj', 'abc.jsonl'));
  expect(findTranscript(dir, 'nope')).toBeNull();
  fs.rmSync(dir, { recursive: true });
});

test('two pids of one session aggregate to the most urgent state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-ev-'));
  const a = spawn('sleep', ['30']); const b = spawn('sleep', ['30']);
  await new Promise((r) => setTimeout(r, 50));
  const write = (p, status, extra = {}) => fs.writeFileSync(path.join(dir, `${p.pid}.json`),
    JSON.stringify({ pid: p.pid, procStart: procStartOf(p.pid), sessionId: 's1', name: 'demo', status, statusUpdatedAt: 5, ...extra }));
  write(a, 'busy'); write(b, 'waiting', { waitingFor: 'permission prompt' });
  fs.writeFileSync(path.join(dir, '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'dead', status: 'busy' }));
  const records = readStatusRecords(dir);
  expect(records.map((r) => r.sessionId).sort()).toEqual(['s1', 's1']);
  expect(aggregateStates(records).get('s1')).toEqual({ state: 'waiting', waitingFor: 'permission prompt', name: 'demo', statusAt: 5 });
  a.kill(); b.kill();
  fs.rmSync(dir, { recursive: true });
});


test('EventLog numbers events, pages by seq and keeps the last max', () => {
  const log = new EventLog(2);
  log.push({ code: 'a' }); log.push({ code: 'b' }); log.push({ code: 'c' });
  expect(log.after(0)).toMatchObject({ seq: 3, events: [{ seq: 2, code: 'b' }, { seq: 3, code: 'c' }] });
  expect(log.after(3)).toEqual({ seq: 3, events: [] });
});

test('watcher is silent on its first tick, then reports changes', () => {
  let states = new Map([['s1', { state: 'busy', waitingFor: null, name: 'demo', statusAt: 0 }]]);
  let t = 0;
  const log = new EventLog();
  const tick = createStatusWatcher({ readAggregated: () => states, readLast: () => null, log, now: () => t });
  tick(); // primes
  states = new Map([['s1', { state: 'waiting', waitingFor: 'permission prompt', name: 'demo', statusAt: 1 }]]);
  t = 1000; tick();
  expect(log.after(0).events).toMatchObject([{ seq: 1, code: 'session.waiting', sessionId: 's1', name: 'demo' }]);
  states = new Map([['s1', { state: 'idle', waitingFor: null, name: 'demo', statusAt: 2 }]]);
  t = 4 * 60 * 1000; tick(); // busySince came from statusAt 0 on the priming tick
  expect(log.after(1).events).toMatchObject([{ code: 'run.stopped', meta: { stopReason: 'Finished after 4 min' } }]);
  states = new Map(); t += 1000; tick(); // session gone: forgotten, no event
  expect(log.after(2).events).toEqual([]);
});

test('GET /events serves the log', async () => {
  const { spawn: sp } = await import('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-home-'));
  const child = sp('node', [new URL('../server.mjs', import.meta.url).pathname], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => child.stdout.once('data', (b) => resolve(JSON.parse(String(b).split('\n')[0]).port)));
  const res = await fetch(`http://127.0.0.1:${port}/events?after=0`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ seq: 0, events: [] });
  child.kill();
  fs.rmSync(home, { recursive: true });
});
