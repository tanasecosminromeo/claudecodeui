// @vitest-environment node
import { expect, it as test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ExecLog, buildTree, commandLabel, liveTree, parseLogLines, procInfo, topAgentAncestor } from '../proctree.mjs';

const T0 = 1_000_000;
const liveRoot = { pid: 100, parent: null, root: 100, argv: 'claude', cmd: 'claude', live: true, rssKb: 1000, startMs: T0, endMs: null, code: null, sig: null };
const liveSh = { pid: 110, parent: 100, root: 100, argv: '/usr/bin/zsh -c sleep 600', cmd: 'sleep 600', live: true, rssKb: 10, startMs: T0 + 50, endMs: null, code: null, sig: null };
const ex = (o) => ({ ev: 'exec', uid: 1000, ...o });
const exit = (o) => ({ ev: 'exit', uid: 1000, sig: 0, ...o });
const byPid = (t) => Object.fromEntries(t.nodes.map((n) => [n.pid, n]));

test('merges finished log records under the live root with exit code and duration', () => {
  const records = [
    ex({ ts: T0 + 10, pid: 120, ppid: 100, lparent: 100, root: 100, argv: 'zsh -c curl -s x' }),
    exit({ ts: T0 + 90, pid: 120, code: 7 }),
    ex({ ts: T0 + 20, pid: 999, ppid: 5, lparent: 5, root: 5, argv: 'not ours' }),
  ];
  const t = buildTree({ rootPids: [100], live: [liveRoot, liveSh], records });
  const n = byPid(t);
  expect(Object.keys(n).map(Number).sort()).toEqual([100, 110, 120]);
  expect(n[120]).toMatchObject({ parent: 100, live: false, startMs: T0 + 10, endMs: T0 + 90, code: 7 });
  expect(n[110]).toMatchObject({ live: true, parent: 100 });
  expect(t.roots).toEqual([100]);
  expect(t.truncated).toBe(0);
});

test('same-pid re-exec keeps one node with the latest argv and the first start', () => {
  const records = [
    ex({ ts: T0 + 10, pid: 120, ppid: 100, lparent: 100, root: 100, argv: 'sh -c curl -s x' }),
    ex({ ts: T0 + 12, pid: 120, ppid: 100, lparent: 100, root: 100, argv: 'curl -s x' }),
    exit({ ts: T0 + 40, pid: 120, code: 0 }),
  ];
  const n = byPid(buildTree({ rootPids: [100], live: [liveRoot], records }));
  expect(n[120]).toMatchObject({ argv: 'curl -s x', startMs: T0 + 10, endMs: T0 + 40 });
});

test('pid reused after exit becomes a new node', () => {
  const records = [
    ex({ ts: T0 + 10, pid: 120, ppid: 100, lparent: 100, root: 100, argv: 'ls' }),
    exit({ ts: T0 + 11, pid: 120, code: 0 }),
    ex({ ts: T0 + 500, pid: 120, ppid: 100, lparent: 100, root: 100, argv: 'pwd' }),
  ];
  const n = byPid(buildTree({ rootPids: [100], live: [liveRoot], records }));
  expect(n[120]).toMatchObject({ argv: 'pwd', startMs: T0 + 500, endMs: null });
});

test('ignores records older than the root process (reused root pid)', () => {
  const records = [ex({ ts: T0 - 5000, pid: 120, ppid: 100, lparent: 100, root: 100, argv: 'old' })];
  expect(buildTree({ rootPids: [100], live: [liveRoot], records }).nodes.map((n) => n.pid)).toEqual([100]);
});

test('attaches to ppid when present, else bridges via lparent, else root', () => {
  const records = [
    ex({ ts: T0 + 10, pid: 130, ppid: 125, lparent: 100, root: 100, argv: 'git status' }), // 125 forked, never exec'd
    ex({ ts: T0 + 20, pid: 140, ppid: 110, lparent: 100, root: 100, argv: 'under live shell' }),
    ex({ ts: T0 + 30, pid: 150, ppid: 7, lparent: 8, root: 100, argv: 'orphan' }),
  ];
  const n = byPid(buildTree({ rootPids: [100], live: [liveRoot, liveSh], records }));
  expect(n[130].parent).toBe(100);
  expect(n[140].parent).toBe(110);
  expect(n[150].parent).toBe(100);
});

test('follows nested claude processes', () => {
  const records = [
    ex({ ts: T0 + 10, pid: 200, ppid: 110, lparent: 110, root: 100, argv: 'claude -p hi' }),
    ex({ ts: T0 + 20, pid: 210, ppid: 200, lparent: 200, root: 200, argv: 'curl inner' }),
  ];
  const n = byPid(buildTree({ rootPids: [100], live: [liveRoot, liveSh], records }));
  expect(n[210]).toMatchObject({ parent: 200, root: 200 });
});

test('a live node whose parent is gone attaches to its root', () => {
  const stray = { ...liveSh, pid: 160, parent: 155 };
  const n = byPid(buildTree({ rootPids: [100], live: [liveRoot, stray], records: [] }));
  expect(n[160].parent).toBe(100);
});

test('caps at the newest nodes, keeps live ones, reports the rest', () => {
  const records = [];
  for (let i = 0; i < 20; i++) records.push(ex({ ts: T0 + 10 + i, pid: 300 + i, ppid: 100, lparent: 100, root: 100, argv: `c${i}` }));
  const t = buildTree({ rootPids: [100], live: [liveRoot, liveSh], records, cap: 7 });
  expect(t.nodes).toHaveLength(7);
  expect(t.truncated).toBe(15);
  expect(t.nodes.filter((n) => n.live).map((n) => n.pid).sort()).toEqual([100, 110]);
  expect(t.nodes.map((n) => n.pid)).toContain(319);
  expect(t.nodes.map((n) => n.pid)).not.toContain(300);
});

test('parseLogLines skips broken lines', () => {
  expect(parseLogLines('{"ev":"exec","pid":1}\nnope\n{"ev":"exit","pid":1}\n')).toHaveLength(2);
});

test('commandLabel shows the real command of a Claude shell wrapper', () => {
  expect(commandLabel("zsh -c source /tmp/test-home/.claude/shell-snapshots/s.sh 2>/dev/null || true && eval 'curl -s x' < /dev/null && pwd -P >| /tmp/x")).toBe('curl -s x');
  expect(commandLabel('/usr/bin/git status')).toBe('/usr/bin/git status');
});

test('procInfo and liveTree read this process and a child', async () => {
  const child = spawn('sleep', ['30']);
  await new Promise((r) => setTimeout(r, 50));
  const me = procInfo(process.pid);
  expect(me.ppid).toBe(process.ppid);
  expect(me.startMs).toBeGreaterThan(Date.now() - 60 * 60 * 1000);
  const tree = liveTree(process.pid);
  const c = tree.find((n) => n.pid === child.pid);
  expect(c).toMatchObject({ parent: process.pid, root: process.pid, live: true, argv: 'sleep 30' });
  expect(tree.find((n) => n.pid === process.pid).parent).toBe(null);
  expect(topAgentAncestor(process.pid)).toBe(process.pid); // vitest's parent is a shell or node, never a claude binary
  child.kill();
});

test('ExecLog reads only records of its uid file, incrementally, and null when missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execlog-'));
  expect(new ExecLog(dir, 1000).records()).toBe(null);
  const file = path.join(dir, '1000.jsonl');
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ ts: now, ev: 'exec', pid: 1 }) + '\n');
  const log = new ExecLog(dir, 1000);
  expect(log.records()).toHaveLength(1);
  fs.appendFileSync(file, JSON.stringify({ ts: now, ev: 'exit', pid: 1 }) + '\n');
  expect(log.records()).toHaveLength(2);
  fs.renameSync(file, file + '.1'); // rotation
  fs.writeFileSync(file, JSON.stringify({ ts: now, ev: 'exec', pid: 2 }) + '\n');
  expect(log.records().map((r) => r.pid)).toEqual([1, 1, 2]);
  fs.rmSync(dir, { recursive: true });
});

test('commandLabel is honest about a Bash-tool wrapper whose command was cut off', () => {
  const cut = '/usr/bin/zsh -c source /tmp/test-home/.claude/shell-snapshots/snapshot-zsh-1.sh || true && setopt NO_EXTENDED_GLOB && { \\builtin unalias -- x; }';
  expect(commandLabel(cut)).toBe('zsh (Bash tool, command cut)');
});

test('ExecLog keeps records appended to the old file before a rotation it did not see', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execlog-'));
  const file = path.join(dir, '1000.jsonl');
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify({ ts: now, ev: 'exec', pid: 1 }) + '\n');
  const log = new ExecLog(dir, 1000);
  expect(log.records()).toHaveLength(1);
  fs.appendFileSync(file, JSON.stringify({ ts: now, ev: 'exit', pid: 1 }) + '\n'); // not read yet
  fs.renameSync(file, file + '.1');
  fs.writeFileSync(file, JSON.stringify({ ts: now, ev: 'exec', pid: 2 }) + '\n');
  expect(log.records().map((r) => `${r.ev}:${r.pid}`)).toEqual(['exec:1', 'exit:1', 'exec:2']);
  fs.rmSync(dir, { recursive: true });
});

test('commandLabel leaves other shells that mention shell-snapshots alone (the snapshot builder)', () => {
  const builder = '/usr/bin/zsh -c -l SNAPSHOT_FILE=/tmp/test-home/.claude/shell-snapshots/snapshot-zsh-1.sh source ~/.zshrc';
  expect(commandLabel(builder)).toBe(builder);
});
