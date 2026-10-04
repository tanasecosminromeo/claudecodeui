// @vitest-environment node
import { expect, it as test } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../agent-exec-tracer.py', import.meta.url));

function run(lines, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-exec-'));
  const r = spawnSync('python3', [script, '--stdin', '--dir', dir], { input: lines.join('\n') + '\n', encoding: 'utf8', env: { ...process.env, ...env } });
  expect(r.status, r.stderr).toBe(0);
  return dir;
}
const read = (dir, uid) => fs.readFileSync(path.join(dir, `${uid}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('turns A/X/Z lines into exec and exit records, one file per uid', () => {
  const dir = run([
    'R',
    'A 50 0 curl', 'A 50 1 -s', 'A 50 2 https://example.com',
    'X 50 40 1000 10 40 3',
    'A 60 0 ls', 'X 60 55 1001 20 20 1',
    'Z 50 0 0',
    'Z 60 2 0',
  ]);
  const a = read(dir, 1000);
  expect(a[0]).toMatchObject({ ev: 'exec', pid: 50, ppid: 40, lparent: 40, root: 10, uid: 1000, argv: 'curl -s https://example.com' });
  expect(typeof a[0].ts).toBe('number');
  expect(a[1]).toMatchObject({ ev: 'exit', pid: 50, uid: 1000, code: 0, sig: 0 });
  expect(read(dir, 1001)[1]).toMatchObject({ ev: 'exit', pid: 60, code: 2 });
  expect(fs.statSync(path.join(dir, '1000.jsonl')).mode & 0o777).toBe(0o600);
});

test('keeps spaces and quotes in arguments', () => {
  const dir = run(['A 7 0 sh', 'A 7 1 -c', "A 7 2 echo \"a  b\" 'c' ünï", 'X 7 1 1000 1 1 3']);
  expect(read(dir, 1000)[0].argv).toBe("sh -c echo \"a  b\" 'c' ünï");
});

test('ignores exits of unknown pids and garbage lines', () => {
  const dir = run(['Z 999 0 0', 'garbage line', 'A 1 0 x', 'X 1 0 1000 1 1 1']);
  expect(read(dir, 1000)).toHaveLength(1);
  expect(fs.readdirSync(dir)).toEqual(['1000.jsonl']);
});

test('rotates the file past the byte cap', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(`A ${i} 0 cmd${i}`, `X ${i} 1 1000 1 1 1`);
  const dir = run(lines, { AGENT_EXEC_MAX_BYTES: '1000' });
  expect(fs.existsSync(path.join(dir, '1000.jsonl.1'))).toBe(true);
  expect(fs.statSync(path.join(dir, '1000.jsonl')).size).toBeLessThan(1200);
});
