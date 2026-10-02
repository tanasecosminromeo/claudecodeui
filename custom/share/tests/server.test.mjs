// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireShare, publish, readShare } from '../lib.mjs';
import { createShareServer } from '../server.mjs';

let tmp; let server; let origin; let s; let base;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'share-srv-'));
  process.env.SHARES_DIR = path.join(tmp, 'shares');
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'report', 'shots'), { recursive: true });
  fs.writeFileSync(path.join(src, 'report', 'index.html'), '<h1>Report</h1><img src="shots/a.png">');
  fs.writeFileSync(path.join(src, 'report', 'shots', 'a.png'), 'PNGDATA');
  fs.writeFileSync(path.join(src, 'plan.md'), '# Plan');
  fs.writeFileSync(path.join(src, 'my notes.txt'), 'spaced');
  fs.mkdirSync(path.join(src, 'plain'));
  fs.writeFileSync(path.join(src, 'plain', 'one.txt'), '1');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'SECRET');
  publish({ srcs: [path.join(src, 'report')], title: 'E2E report', dest: 'reports', sessionId: 'sess-1' });
  publish({ srcs: [path.join(src, 'plan.md')], title: 'Plan', sessionId: 'sess-1' });
  publish({ srcs: [path.join(src, 'my notes.txt')], title: 'Notes', sessionId: 'sess-1' });
  publish({ srcs: [path.join(src, 'plain')], title: 'Plain dir', sessionId: 'sess-1' });
  const dir = path.join(tmp, 'shares', 'sess-1');
  fs.writeFileSync(path.join(dir, '.hidden'), 'h');
  fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(dir, 'escape.txt'));
  publish({ srcs: [path.join(src, 'plan.md')], title: 'Old', sessionId: 'sess-old' });
  expireShare('sess-old');
  fs.mkdirSync(path.join(tmp, 'shares', 'broken'));
  fs.writeFileSync(path.join(tmp, 'shares', 'broken', 'share.json'), '{"id":"broken","tok');
  s = readShare('sess-1');
  server = createShareServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  base = `${origin}/share/sess-1/${s.token}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.SHARES_DIR;
});

const get = (url, init) => fetch(url, { redirect: 'manual', ...init });

async function expect404(url) {
  const r = await get(url);
  expect(r.status, url).toBe(404);
  expect(await r.text()).toBe('Not Found');
}

describe('share server', () => {
  it('lists the share with its items and files, never share.json', async () => {
    const r = await get(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    const html = await r.text();
    expect(html).toContain('E2E report');
    expect(html).toContain('href="reports/report/index.html"');
    expect(html).toContain('href="my%20notes.txt"');
    expect(html).toContain('href="plan.md"');
    expect(html).not.toContain('share.json');
    expect(html).not.toContain('.hidden');
  });

  it('redirects the share root and folders to a trailing slash', async () => {
    const r = await get(base);
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe(`/share/sess-1/${s.token}/`);
    const d = await get(`${base}/reports/report`);
    expect(d.status).toBe(301);
    expect(d.headers.get('location')).toBe(`/share/sess-1/${s.token}/reports/report/`);
  });

  it('serves files with their content type, and a folder by its index.html', async () => {
    const html = await get(`${base}/reports/report/`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('<h1>Report</h1>');
    const png = await get(`${base}/reports/report/shots/a.png`);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(await png.text()).toBe('PNGDATA');
    const md = await get(`${base}/plan.md`);
    expect(md.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await (await get(`${base}/my%20notes.txt`)).text()).toBe('spaced');
  });

  it('lists a folder without index.html', async () => {
    const r = await get(`${base}/plain/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('href="one.txt"');
  });

  it('answers HEAD without a body', async () => {
    const r = await get(`${base}/plan.md`, { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('');
  });

  it('sets the privacy headers on hits and misses', async () => {
    for (const url of [`${base}/plan.md`, `${origin}/nope`]) {
      const r = await get(url);
      expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');
      expect(r.headers.get('referrer-policy')).toBe('no-referrer');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('sandboxes everything it serves away from the CloudCLI origin', async () => {
    // Same host as CloudCLI, whose login token lives in localStorage: shared pages
    // must not run with that origin, or a published page's script could read it.
    for (const url of [`${base}/`, `${base}/reports/report/index.html`, `${base}/plain/`, `${origin}/nope`]) {
      const csp = (await get(url)).headers.get('content-security-policy') || '';
      expect(csp, url).toMatch(/(^|;)\s*sandbox\b/);
      expect(csp, url).not.toMatch(/allow-same-origin/);
      expect(csp, url).toMatch(/allow-scripts/);
    }
  });

  it('answers the same 404 for every way in that is not allowed', async () => {
    const old = readShare('sess-old');
    for (const url of [
      `${origin}/`,
      `${origin}/share/`,
      `${origin}/share/sess-1/`,
      `${origin}/share/sess-1/wrong-token/`,
      `${origin}/share/sess-1/${s.token.slice(0, -1)}x/plan.md`,
      `${origin}/share/sess-old/${old.token}/`,
      `${origin}/share/nope/${s.token}/`,
      `${origin}/share/bad%2Fid/${s.token}/`,
      `${origin}/share/broken/tok/`,
      `${base}/share.json`,
      `${base}/.hidden`,
      `${base}/%2e%2e/%2e%2e/secret.txt`,
      `${base}/..%2f..%2fsecret.txt`,
      `${base}/escape.txt`,
      `${base}/missing.txt`,
    ]) await expect404(url);
  });

  it('rejects other methods', async () => {
    expect((await get(`${base}/plan.md`, { method: 'POST' })).status).toBe(404);
  });
});
