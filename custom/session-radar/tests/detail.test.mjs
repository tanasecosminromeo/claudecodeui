// @vitest-environment node
import { expect, it as test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { livePidsOf, machineStats, parseTranscriptTail, pendingSummary, procStartOf, rssKb, shellCommand, stopSession } from '../detail.mjs';

const line = (o) => JSON.stringify(o);

test('counts agents without a result, and background agents until notified', () => {
  const text = [
    line({ type: 'mode', mode: 'normal' }),
    line({ type: 'assistant', gitBranch: 'main', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 90, cache_creation_input_tokens: 8 }, content: [
      { type: 'tool_use', id: 't1', name: 'Agent', input: {} },
      { type: 'tool_use', id: 't2', name: 'Agent', input: { run_in_background: true } },
      { type: 'tool_use', id: 't3', name: 'Bash', input: {} },
    ] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }, { type: 'tool_result', tool_use_id: 't2' }] } }),
  ].join('\n');
  let r = parseTranscriptTail(text);
  expect(r.agents).toBe(1);
  expect(r.model).toBe('claude-sonnet-5-5');
  expect(r.branch).toBe('main');
  expect(r.mode).toBe('normal');
  expect(r.contextTokens).toBe(100);
  r = parseTranscriptTail(text + '\n' + line({ type: 'user', message: { content: 'x <task-notification><tool-use-id>t2</tool-use-id></task-notification>' } }));
  expect(r.agents).toBe(0);
});

test('ignores broken lines and synthetic models', () => {
  const r = parseTranscriptTail('{"type":"assi\n' + line({ type: 'assistant', message: { model: '<synthetic>', content: [] } }));
  expect(r.model).toBe(null);
  expect(r.agents).toBe(0);
});

test('shellCommand only recognises Claude shell-snapshot shells', () => {
  expect(shellCommand('/usr/bin/zsh\0-c\0ls')).toBe(null);
  const cmd = ['/usr/bin/zsh', '-c', "source /tmp/test-home/.claude/shell-snapshots/s.sh 2>/dev/null || true && eval 'sleep 600' < /dev/null && pwd -P >| /tmp/x"].join('\0');
  expect(shellCommand(cmd)).toMatch(/sleep 600/);
});

test('rssKb reads this process', () => { expect(rssKb(process.pid)).toBeGreaterThan(1000); expect(rssKb(999999999)).toBe(0); });

test('stopSession signals only a live pid whose start time still matches', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-'));
  const child = spawn('sleep', ['30']);
  const start = procStartOf(child.pid);
  fs.writeFileSync(path.join(dir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: 's1', procStart: start }));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ pid: process.pid, sessionId: 's1', procStart: '1' })); // reused pid
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ pid: child.pid, sessionId: 'other', procStart: start }));
  expect(livePidsOf('s1', dir)).toEqual([child.pid]);
  expect(livePidsOf('nope', dir)).toEqual([]);
  const sent = [];
  expect(stopSession('s1', dir, (pid, sig) => sent.push([pid, sig]))).toEqual([child.pid]);
  expect(sent).toEqual([[child.pid, 'SIGTERM']]);
  child.kill();
  fs.rmSync(dir, { recursive: true });
});

test('machineStats reports memory and load', () => {
  const m = machineStats();
  expect(m.memTotalMb).toBeGreaterThan(0);
  expect(m.cpus).toBeGreaterThan(0);
  expect(m.load).toHaveLength(3);
});

const ask = (id, name, input, extra = {}) => line({ type: 'assistant', ...extra, message: { content: [{ type: 'tool_use', id, name, input }] } });
const answer = (id) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id }] } });

test('pending is the latest main-thread tool request without a result', () => {
  expect(parseTranscriptTail(ask('a', 'Bash', { command: 'touch /tmp/x.txt' })).pending)
    .toEqual({ tool: 'Bash', summary: 'touch /tmp/x.txt' });
  expect(parseTranscriptTail([ask('a', 'Bash', { command: 'ls' }), answer('a')].join('\n')).pending).toBe(null);
  expect(parseTranscriptTail([ask('a', 'Bash', { command: 'ls' }), ask('b', 'Edit', { file_path: '/w/a.js' })].join('\n')).pending)
    .toEqual({ tool: 'Edit', summary: '/w/a.js' });
  // a subagent's request is not what the session's own prompt is about
  expect(parseTranscriptTail([ask('a', 'Bash', { command: 'ls' }), ask('s', 'Bash', { command: 'rm x' }, { isSidechain: true })].join('\n')).pending)
    .toEqual({ tool: 'Bash', summary: 'ls' });
  expect(parseTranscriptTail('').pending).toBe(null);
});

test('pendingSummary names what a tool request is about', () => {
  expect(pendingSummary('Bash', { command: 'git   status\n  --short' })).toBe('git status --short');
  expect(pendingSummary('Write', { file_path: '/w/b.md' })).toBe('/w/b.md');
  expect(pendingSummary('NotebookEdit', { notebook_path: '/w/n.ipynb' })).toBe('/w/n.ipynb');
  expect(pendingSummary('WebFetch', { url: 'https://example.com' })).toBe('https://example.com');
  expect(pendingSummary('mcp__x__y', { a: 1 })).toBe('');
  const long = pendingSummary('Bash', { command: 'x'.repeat(300) });
  expect(long.length).toBe(120);
  expect(long.endsWith('…')).toBe(true);
});
