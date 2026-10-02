// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../share.mjs', import.meta.url));
let tmp; let env;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'share-cli-'));
  env = { ...process.env, HOME: tmp, SHARES_DIR: path.join(tmp, 'shares'), SHARE_BASE_URL: 'https://ex.test' };
  fs.writeFileSync(path.join(tmp, 'plan.md'), '# plan');
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { env, cwd: tmp, encoding: 'utf8' });
const json = (...args) => JSON.parse(run(...args, '--json').stdout);

describe('share CLI', () => {
  it('publishes into the session share and prints the links and expiry', () => {
    const r = run('publish', 'plan.md', '--title', 'The plan', '--session', 'sess-1');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/https:\/\/ex\.test\/share\/sess-1\/[A-Za-z0-9_-]{32}\/plan\.md/);
    expect(r.stdout).toMatch(/Expires: \d{4}-\d{2}-\d{2} \d{2}:\d{2} EES?T/);
    expect(fs.existsSync(path.join(tmp, 'shares', 'sess-1', 'plan.md'))).toBe(true);
  });

  it('fails with exit 2 when no Claude session can be found', () => {
    const r = run('publish', 'plan.md');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/no Claude session found/);
  });

  it('fails with exit 1 on usage errors', () => {
    expect(run('publish', '--session', 's').status).toBe(1);
    expect(run('bogus').status).toBe(1);
    expect(run('publish', 'plan.md', '--session', 's', '--ttl', 'soon').status).toBe(1);
  });

  it('lists shares as JSON with urls and without raw tokens', () => {
    run('publish', 'plan.md', '--title', 'Plan', '--session', 'sess-1');
    const [s] = json('list');
    expect(s).toMatchObject({ id: 'sess-1', sessionId: 'sess-1', separate: false, expired: false });
    expect(s.token).toBeUndefined();
    expect(s.url).toMatch(/^https:\/\/ex\.test\/share\/sess-1\/.{32}\/$/);
    expect(s.items[0]).toMatchObject({ title: 'Plan', kind: 'markdown', url: `${s.url}plan.md` });
  });

  it('adds session details with --with-sessions', () => {
    run('publish', 'plan.md', '--session', 'abcdef123456');
    const [s] = json('list', '--with-sessions');
    expect(s.session).toMatchObject({ status: 'ended', title: 'abcdef12', appSessionId: 'abcdef123456' });
  });

  it('creates a separate share with its own ttl', () => {
    run('publish', 'plan.md', '--session', 'sess-1', '--separate', '--ttl', '2h');
    const [s] = json('list');
    expect(s.id).toMatch(/^x-/);
    expect(s.separate).toBe(true);
    expect(Date.parse(s.expiresAt) - Date.now()).toBeGreaterThan(1.9 * 3600e3);
    expect(Date.parse(s.expiresAt) - Date.now()).toBeLessThan(2.1 * 3600e3);
  });

  it('extends, expires, prints the url and purges', () => {
    run('publish', 'plan.md', '--session', 'sess-1');
    const before = Date.parse(json('list')[0].expiresAt);
    expect(run('extend', 'sess-1', '--by', '3d').status).toBe(0);
    expect(Date.parse(json('list')[0].expiresAt) - before).toBe(72 * 3600e3);
    expect(run('expire', 'sess-1').status).toBe(0);
    expect(json('list')[0].expired).toBe(true);
    expect(run('url', 'sess-1').stdout.trim()).toBe(json('list')[0].url);
    expect(run('purge', '--expired').stdout).toContain('sess-1');
    expect(json('list')).toEqual([]);
  });

  it('reports unknown shares as errors', () => {
    const r = run('extend', 'nope');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no such share/);
  });
});
