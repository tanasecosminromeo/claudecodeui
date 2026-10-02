// @vitest-environment node
import { expect, it as test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { livePidsOf, machineStats, parseTranscriptTail, procStartOf, rssKb, shellCommand, stopSession } from '../detail.mjs';

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
