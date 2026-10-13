// @vitest-environment node
import { expect, it as test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranscriptTail, transcriptDetail } from '../detail.mjs';
import { currentCommand, recentCommands, sessionActivity, showText } from '../activity.mjs';

const line = (o) => JSON.stringify(o);
const T0 = Date.parse('2026-10-13T06:00:00Z');
const at = (sec) => new Date(T0 + sec * 1000).toISOString();
const FAKE_KEY = `sk-${'Q9w8E7r6T5y4U3i2O1p0A'}`; // built at run time

// A transcript: a background agent (still running), a background Bash that finished, a Monitor
// still running, a foreground agent that answered.
const fixture = [
  line({ type: 'assistant', timestamp: at(0), message: { content: [
    { type: 'tool_use', id: 'ag1', name: 'Agent', input: { description: 'Audit the radar masking', run_in_background: true } },
    { type: 'tool_use', id: 'bg1', name: 'Bash', input: { command: 'npm run build', run_in_background: true, description: 'Build the bundle' } },
  ] } }),
  line({ type: 'user', timestamp: at(1), message: { content: [{ type: 'tool_result', tool_use_id: 'ag1' }, { type: 'tool_result', tool_use_id: 'bg1' }] } }),
  line({ type: 'user', timestamp: at(60), message: { content: 'x <task-notification><tool-use-id>bg1</tool-use-id><status>completed</status></task-notification>' } }),
  line({ type: 'assistant', timestamp: at(120), message: { content: [
    { type: 'tool_use', id: 'mon1', name: 'Monitor', input: { description: `Watch the log ${FAKE_KEY}` } },
    { type: 'tool_use', id: 'fg1', name: 'Agent', input: { description: 'Quick look' } },
  ] } }),
  line({ type: 'user', timestamp: at(121), message: { content: [{ type: 'tool_result', tool_use_id: 'fg1' }, { type: 'tool_result', tool_use_id: 'mon1' }] } }),
].join('\n');

test('running work: background agents and tasks still running, with description and start time', () => {
  const r = parseTranscriptTail(fixture);
  expect(r.agents).toBe(1);
  const byId = Object.fromEntries(r.running.map((x) => [x.id, x]));
  expect(Object.keys(byId).sort()).toEqual(['ag1', 'mon1']);
  expect(byId.ag1).toEqual({ id: 'ag1', kind: 'agent', description: 'Audit the radar masking', startedAt: T0 });
  expect(byId.mon1.kind).toBe('task');
  expect(byId.mon1.startedAt).toBe(T0 + 120000);
});

test('a finished background Bash leaves the running list; a foreground agent never enters it', () => {
  const r = parseTranscriptTail(fixture);
  expect(r.running.some((x) => x.id === 'bg1')).toBe(false);
  expect(r.running.some((x) => x.id === 'fg1')).toBe(false);
});

test('a background Bash description falls back to its command', () => {
  const text = line({ type: 'assistant', timestamp: at(0), message: { content: [
    { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'tail -f app.log', run_in_background: true } },
  ] } });
  expect(parseTranscriptTail(text).running[0].description).toBe('tail -f app.log');
});

test('session activity masks descriptions and shapes them into agent and task lists', () => {
  const act = sessionActivity({ running: parseTranscriptTail(fixture).running, shells: [], records: null, roots: [], now: T0 + 180000 });
  expect(act.agents).toEqual([{ description: 'Audit the radar masking', startedAt: T0 }]);
  expect(act.tasks[0].description).toContain('Watch the log');
  expect(act.tasks[0].description).not.toContain(FAKE_KEY);
  expect(act.current).toBe(null);
  expect(act.recent).toEqual([]);
});

test('the current command is the youngest Bash-tool shell, masked and shortened', () => {
  const shells = [
    { pid: 900, cmd: 'sleep 600' },
    { pid: 950, cmd: `curl -H "Authorization: Bearer ${FAKE_KEY}" https://example.com` },
  ];
  const cur = currentCommand(shells);
  expect(cur).toContain('curl -H');
  expect(cur).not.toContain(FAKE_KEY);
  expect(currentCommand([])).toBe(null);
  expect(currentCommand([{ pid: 1, cmd: 'x'.repeat(200) }]).length).toBe(80);
});

test('recent commands: last three distinct within two minutes, the session roots only', () => {
  const now = 1_000_000_000_000;
  const rec = (ts, root, argv, ev = 'exec') => ({ ts, ev, root, pid: ts, argv });
  const records = [
    rec(now - 300_000, 5, 'git status'), // too old
    rec(now - 100_000, 5, 'npm test'),
    rec(now - 90_000, 9, 'wget elsewhere'), // another session
    rec(now - 80_000, 5, 'curl https://example.com/a'),
    rec(now - 70_000, 5, 'curl https://example.com/a'), // repeated: once
    rec(now - 60_000, 5, '/opt/bin/claude --model claude-x --output-format stream-json'), // a nested Claude start: not a command
    rec(now - 50_000, 5, 'git log --oneline'),
    rec(now - 40_000, 5, 'ls', 'exit'),
    rec(now - 30_000, 5, 'make build'),
  ];
  expect(recentCommands(records, [5], now)).toEqual(['make build', 'git log --oneline', 'curl https://example.com/a']);
});

test('recent commands mask secrets in argv', () => {
  const now = 1_000_000_000_000;
  const out = recentCommands([{ ts: now - 1000, ev: 'exec', root: 1, pid: 2, argv: `deploy --api-key=${FAKE_KEY}` }], [1], now);
  expect(out[0]).not.toContain(FAKE_KEY);
  expect(out[0]).toContain('•••');
});

test('no tracer means no recent line at all', () => {
  expect(sessionActivity({ records: null, roots: [1], now: 5 }).recent).toEqual([]);
});

test('showText masks first, then shortens, so a secret is never cut in half', () => {
  const s = showText(`echo ${FAKE_KEY}`, 12);
  expect(s).not.toContain('Q9w8E7');
  expect(s.length).toBeLessThanOrEqual(12);
});

test('transcriptDetail caches by file size and mtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-activity-'));
  const file = path.join(dir, 's.jsonl');
  fs.writeFileSync(file, `${fixture}\n`);
  const first = transcriptDetail(file);
  expect(first.running.map((x) => x.id).sort()).toEqual(['ag1', 'mon1']);
  expect(transcriptDetail(file)).toBe(first); // same size and mtime: the cached value
  fs.appendFileSync(file, `${line({ type: 'assistant', timestamp: at(200), message: { content: [{ type: 'tool_use', id: 'ag2', name: 'Agent', input: { description: 'Late' } }] } })}\n`);
  const second = transcriptDetail(file);
  expect(second).not.toBe(first);
  expect(second.running.map((x) => x.id)).toContain('ag2');
});
