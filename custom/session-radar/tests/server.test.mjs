// @vitest-environment node
import { expect, it as test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { procStartOf } from '../detail.mjs';
import { otherAgentRows, treeFor } from '../tree-route.mjs';

const fakeLog = (recs) => ({ records: () => recs });

test('treeFor answers 400 / 404 / 200 with history flag', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-'));
  const uid = process.getuid();
  expect(treeFor(null, { sessionsDir: dir, execLog: fakeLog(null), uid }).status).toBe(400);
  expect(treeFor('nope', { sessionsDir: dir, execLog: fakeLog(null), uid }).status).toBe(404);
  const child = spawn('sleep', ['30']);
  await new Promise((r) => setTimeout(r, 50));
  fs.writeFileSync(path.join(dir, `${child.pid}.json`), JSON.stringify({ pid: child.pid, sessionId: 's1', procStart: procStartOf(child.pid) }));
  let r = treeFor('s1', { sessionsDir: dir, execLog: fakeLog(null), uid });
  expect(r.status).toBe(200);
  expect(r.body.history).toBe(false);
  expect(r.body.roots).toEqual([child.pid]);
  expect(r.body.nodes[0]).toMatchObject({ pid: child.pid, live: true, argv: 'sleep 30' });
  r = treeFor('s1', { sessionsDir: dir, execLog: fakeLog([{ ts: Date.now(), ev: 'exec', pid: 1234567, ppid: child.pid, lparent: child.pid, root: child.pid, uid: 1, argv: 'ls' }]), uid });
  expect(r.body.history).toBe(true);
  expect(r.body.nodes.map((n) => n.pid)).toContain(1234567);
  // pid: form, this process
  r = treeFor(`pid:${process.pid}`, { sessionsDir: dir, execLog: fakeLog(null), uid });
  expect(r.status).toBe(200);
  expect(treeFor('pid:1', { sessionsDir: dir, execLog: fakeLog(null), uid }).status).toBe(404); // not ours
  child.kill();
  fs.rmSync(dir, { recursive: true });
});

test('otherAgentRows describes a process as a row', () => {
  // No claude processes are guaranteed in a test, so exercise the row shape through the injected finder on this pid.
  // This test process may itself be younger than the registration grace period: pretend it is not.
  const rows = otherAgentRows(new Set(), process.getuid(), () => [process.pid], () => Date.now() + 60000);
  expect(rows[0]).toMatchObject({ sessionId: `pid:${process.pid}`, state: 'other', other: true, live: true, pids: [process.pid] });
  expect(rows[0].title.length).toBeGreaterThan(0);
  expect(rows[0].cwd).toBe(process.cwd());
  expect(rows[0].rssMb).toBeGreaterThan(0);
});

test('otherAgentRows skips a process younger than 10 s (Claude Code registers its status file at start)', async () => {
  const child = spawn('sleep', ['30']);
  await new Promise((r) => setTimeout(r, 50));
  expect(otherAgentRows(new Set(), process.getuid(), () => [child.pid])).toEqual([]);
  child.kill();
});
