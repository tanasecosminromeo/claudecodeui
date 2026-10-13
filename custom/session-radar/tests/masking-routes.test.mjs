// @vitest-environment node
// Route-level masking: what GET /tree, the "other agent" rows and GET /leftovers send to the browser.
import { afterAll, expect, it as test } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leftoversFor } from '../leftovers.mjs';
import { otherAgentRows, treeFor } from '../tree-route.mjs';

// Fake secrets, assembled at run time.
const HEX64 = 'ab'.repeat(32);
const TOKEN_JSON = `{"mcpServers":{"browser":{"command":"node","env":{"CLOUDCLI_BROWSER_USE_MCP_TOKEN":"${HEX64}","PORT":"3001"}}}}`;
const FAKE_KEY = 'sk' + '-' + 'a'.repeat(24);
const MARKER = 'radar-mask-test';
const children = [];
const SLEEP = 'setTimeout(() => {}, 30000)';

// Starts a node process whose argv carries the fake secrets; waits until /proc shows them.
async function spawnWithArgs(args, argv0) {
  const child = spawn(process.execPath, ['-e', `${SLEEP}; /* ${MARKER} */`, '--', ...args], argv0 ? { argv0, stdio: 'ignore' } : { stdio: 'ignore' });
  children.push(child);
  const cmdPath = `/proc/${child.pid}/cmdline`;
  for (let i = 0; i < 100; i++) {
    try { if (fs.readFileSync(cmdPath, 'utf8').includes(MARKER)) return child.pid; } catch { /* not exec'd yet */ }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('child did not start');
}

afterAll(() => { for (const c of children) c.kill(); });

const noLog = { records: () => null };
const dirs = () => ({ sessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'radar-sess-')), uid: process.getuid() });

test('GET /tree masks secrets in argv and cmd of every node', async () => {
  const pid = await spawnWithArgs(['--mcp-config', TOKEN_JSON, `--api-key=${FAKE_KEY}`]);
  const r = treeFor(`pid:${pid}`, { ...dirs(), execLog: noLog });
  expect(r.status).toBe(200);
  const node = r.body.nodes.find((n) => n.pid === pid);
  expect(node.argv).toContain('"CLOUDCLI_BROWSER_USE_MCP_TOKEN":"•••"');
  expect(node.argv).toContain('--api-key=•••');
  expect(node.argv).toContain('"PORT":"3001"');
  const wire = JSON.stringify(r.body);
  expect(wire).not.toContain(HEX64);
  expect(wire).not.toContain(FAKE_KEY);
  expect(node.cmd).not.toContain(HEX64);
});

test('a Claude CLI node shows a short label and keeps the masked full argv for the tooltip', async () => {
  const resume = '3f2b1c0d-9a8b-4c7d-8e6f-5a4b3c2d1e0f';
  const pid = await spawnWithArgs([
    '--output-format', 'stream-json', '--model', 'claude-opus-4', '--resume', resume,
    '--mcp-config', TOKEN_JSON,
  ], '/opt/tools/claude');
  const r = treeFor(`pid:${pid}`, { ...dirs(), execLog: noLog });
  const node = r.body.nodes.find((n) => n.pid === pid);
  expect(node.cmd).toBe('claude (claude-opus-4, resume 3f2b1c0d)');
  expect(node.fullArgv).toContain('--output-format stream-json');
  expect(node.fullArgv).toContain('"CLOUDCLI_BROWSER_USE_MCP_TOKEN":"•••"');
  expect(node.fullArgv).not.toContain(HEX64);
  expect(node.fullArgv).toContain(resume);
});

test('other-agent rows mask the title and the commands', async () => {
  const pid = await spawnWithArgs([`--api-key=${FAKE_KEY}`, '--mcp-config', TOKEN_JSON]);
  const rows = otherAgentRows(new Set(), process.getuid(), () => [pid], () => Date.now() + 60000);
  const row = rows.find((r) => r.pids[0] === pid);
  expect(row).toBeDefined();
  expect(row.title.length).toBeLessThanOrEqual(70); // the title is cut, so the key may fall past the cut
  expect(row.title).not.toContain(FAKE_KEY);
  const wire = JSON.stringify(rows);
  expect(wire).not.toContain(HEX64);
  expect(wire).not.toContain(FAKE_KEY);
});

test('GET /leftovers masks the command of each process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-lo-mask-'));
  const unit = 'cloudcli-claude-aaaaaaaa-1111-2222-3333-444444444444-AAAAAA.scope';
  const cgroupRoot = path.join(root, 'app.slice');
  const procRoot = path.join(root, 'proc');
  const recordsDir = path.join(root, 'records');
  fs.mkdirSync(path.join(cgroupRoot, unit), { recursive: true });
  fs.mkdirSync(recordsDir, { recursive: true });
  fs.mkdirSync(path.join(procRoot, '700'), { recursive: true });
  fs.writeFileSync(path.join(procRoot, 'stat'), 'cpu 1 2 3\nbtime 1700000000\n');
  fs.writeFileSync(path.join(procRoot, '700', 'stat'), `700 (node) S 1 ${Array(17).fill('0').join(' ')} 1000\n`);
  fs.writeFileSync(path.join(procRoot, '700', 'cmdline'), `node\0server.js\0--mcp-config\0${TOKEN_JSON}\0`);
  fs.writeFileSync(path.join(procRoot, '700', 'status'), 'VmRSS:\t2048 kB\n');
  fs.writeFileSync(path.join(cgroupRoot, unit, 'cgroup.procs'), '700\n');
  const body = leftoversFor({ serverStartedAt: 1, cgroupRoot, procRoot, recordsDir, minAgeMs: 0, now: 1700100000000 });
  const cmd = body.groups[0].processes[0].command;
  expect(cmd).toContain('"CLOUDCLI_BROWSER_USE_MCP_TOKEN":"•••"');
  expect(JSON.stringify(body)).not.toContain(HEX64);
});
