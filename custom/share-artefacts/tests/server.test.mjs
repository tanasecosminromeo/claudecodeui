// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../../share/share.mjs', import.meta.url));
let tmp; let proc; let origin; let env;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'share-plugin-'));
  env = { ...process.env, HOME: tmp, SHARES_DIR: path.join(tmp, 'shares'), SHARE_BASE_URL: 'https://ex.test', SHARE_BIN: CLI };
  fs.writeFileSync(path.join(tmp, 'a.md'), 'a');
  spawnSync(process.execPath, [CLI, 'publish', path.join(tmp, 'a.md'), '--title', 'A', '--session', 'sess-1'], { env });
  proc = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let buf = '';
    proc.stdout.on('data', (c) => {
      buf += c;
      const m = buf.match(/\{"ready":true,"port":(\d+)\}/);
      if (m) resolve(Number(m[1]));
    });
    proc.on('exit', () => reject(new Error('plugin server exited')));
  });
  origin = `http://127.0.0.1:${port}`;
});

afterAll(() => { proc?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const post = (p, body) => fetch(`${origin}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('share-artefacts plugin server', () => {
  it('lists shares with session details', async () => {
    const r = await fetch(`${origin}/artefacts`);
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(typeof data.now).toBe('number');
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0]).toMatchObject({ id: 'sess-1', expired: false, session: { appSessionId: 'sess-1' } });
    expect(data.groups[0].items[0].title).toBe('A');
  });

  it('expires and extends a share', async () => {
    expect((await post('/expire', { id: 'sess-1' })).status).toBe(200);
    expect((await (await fetch(`${origin}/artefacts`)).json()).groups[0].expired).toBe(true);
    expect((await post('/extend', { id: 'sess-1', by: '24h' })).status).toBe(200);
    expect((await (await fetch(`${origin}/artefacts`)).json()).groups[0].expired).toBe(false);
  });

  it('rejects bad ids and durations without running anything', async () => {
    expect((await post('/extend', { id: '../x' })).status).toBe(400);
    expect((await post('/extend', { id: 'sess-1', by: '1; rm -rf /' })).status).toBe(400);
    expect((await post('/expire', {})).status).toBe(400);
  });

  it('reports unknown shares as errors', async () => {
    const r = await post('/expire', { id: 'nope' });
    expect(r.status).toBe(500);
    expect((await r.json()).error).toMatch(/no such share/);
  });
});
