// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  expireShare, extendShare, formatLeft, formatLocal, isExpired, itemUrl, listShares, newSeparateId, newToken, parseDuration,
  publish, purge, readShare, resolveInside, shareUrl,
} from '../lib.mjs';

const H = 3600e3;
let tmp; let shares; let src;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'share-lib-'));
  shares = path.join(tmp, 'shares');
  src = path.join(tmp, 'src');
  fs.mkdirSync(src);
  process.env.SHARES_DIR = shares;
  process.env.SHARE_BASE_URL = 'https://ex.test';
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.SHARES_DIR; delete process.env.SHARE_BASE_URL;
});

function file(rel, body = 'x') {
  const p = path.join(src, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}
const base = { sessionId: 'sess-1', projectPath: '/w/p' };

describe('parseDuration', () => {
  it('reads minutes, hours and days', () => {
    expect(parseDuration('90m')).toBe(90 * 60e3);
    expect(parseDuration('24h')).toBe(24 * H);
    expect(parseDuration('3d')).toBe(72 * H);
  });
  it('rejects anything else', () => {
    for (const bad of ['', '5', 'h', '-1h', '1w', '1.5h']) expect(() => parseDuration(bad)).toThrow();
  });
});

describe('ids', () => {
  it('makes 32-char url-safe tokens and x- ids', () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(newToken()).not.toBe(newToken());
    expect(newSeparateId()).toMatch(/^x-[a-z2-7]{8}$/);
  });
});

describe('publish', () => {
  it('creates the session share on first publish with a 24h expiry', () => {
    const now = Date.parse('2026-10-02T10:00:00Z');
    const { share, item } = publish({ ...base, srcs: [file('plan.md')], title: 'Plan', now });
    expect(share.id).toBe('sess-1');
    expect(share.separate).toBe(false);
    expect(Date.parse(share.expiresAt) - now).toBe(24 * H);
    expect(item).toMatchObject({ title: 'Plan', path: 'plan.md', kind: 'markdown' });
    expect(fs.readFileSync(path.join(shares, 'sess-1', 'plan.md'), 'utf8')).toBe('x');
    expect(readShare('sess-1').token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('adds items to the same share and keeps token and expiry', () => {
    const a = publish({ ...base, srcs: [file('plan.md')], title: 'Plan', now: 1000 });
    const b = publish({ ...base, srcs: [file('impl.md')], title: 'Impl', now: 5000 });
    expect(b.share.token).toBe(a.share.token);
    expect(b.share.expiresAt).toBe(a.share.expiresAt);
    expect(readShare('sess-1').items.map((i) => i.title)).toEqual(['Plan', 'Impl']);
  });

  it('replaces an item published again under the same title', () => {
    publish({ ...base, srcs: [file('old.md', 'old')], title: 'Plan', now: 1000 });
    publish({ ...base, srcs: [file('new.md', 'new')], title: 'Plan', now: 2000 });
    const s = readShare('sess-1');
    expect(s.items).toHaveLength(1);
    expect(s.items[0].path).toBe('new.md');
    expect(fs.existsSync(path.join(shares, 'sess-1', 'old.md'))).toBe(false);
  });

  it('suffixes a clashing name instead of overwriting', () => {
    publish({ ...base, srcs: [file('a/plan.md', 'one')], title: 'One', now: 1000 });
    const { item } = publish({ ...base, srcs: [file('b/plan.md', 'two')], title: 'Two', now: 2000 });
    expect(item.path).toBe('plan-2.md');
    expect(fs.readFileSync(path.join(shares, 'sess-1', 'plan.md'), 'utf8')).toBe('one');
  });

  it('copies a directory recursively and points the item at its index.html', () => {
    file('report/index.html', '<img src="shots/a.png">');
    file('report/shots/a.png', 'png');
    const { item } = publish({ ...base, srcs: [path.join(src, 'report')], title: 'Report', dest: 'reports', now: 1 });
    expect(item).toMatchObject({ path: 'reports/report/index.html', kind: 'html' });
    expect(fs.existsSync(path.join(shares, 'sess-1', 'reports/report/shots/a.png'))).toBe(true);
  });

  it('skips symlinks that point outside the published folder', () => {
    file('outside.txt', 'secret');
    file('dir/ok.txt');
    fs.symlinkSync(path.join(src, 'outside.txt'), path.join(src, 'dir', 'leak.txt'));
    publish({ ...base, srcs: [path.join(src, 'dir')], title: 'Dir', now: 1 });
    expect(fs.existsSync(path.join(shares, 'sess-1', 'dir', 'ok.txt'))).toBe(true);
    expect(fs.existsSync(path.join(shares, 'sess-1', 'dir', 'leak.txt'))).toBe(false);
  });

  it('refuses missing sources and sources inside the shares folder', () => {
    expect(() => publish({ ...base, srcs: [path.join(src, 'nope.md')], title: 'X', now: 1 })).toThrow(/not found/);
    publish({ ...base, srcs: [file('plan.md')], title: 'Plan', now: 1 });
    expect(() => publish({ ...base, srcs: [path.join(shares, 'sess-1', 'plan.md')], title: 'Y', now: 1 })).toThrow(/inside/);
  });

  it('makes a separate share with its own id and ttl that remembers the session', () => {
    const { share } = publish({ ...base, srcs: [file('plan.md')], title: 'P', separate: true, ttlMs: 2 * H, now: 0 });
    expect(share.id).toMatch(/^x-/);
    expect(share.separate).toBe(true);
    expect(share.sessionId).toBe('sess-1');
    expect(Date.parse(share.expiresAt)).toBe(2 * H);
  });

  it('revives an expired share for another 24h when publishing to it', () => {
    publish({ ...base, srcs: [file('a.md')], title: 'A', now: 0 });
    const now = 48 * H;
    const { share } = publish({ ...base, srcs: [file('b.md')], title: 'B', now });
    expect(Date.parse(share.expiresAt)).toBe(now + 24 * H);
  });
});

describe('expiry', () => {
  it('extends from now when expired and from expiresAt when live', () => {
    publish({ ...base, srcs: [file('a.md')], title: 'A', now: 0 });
    expect(Date.parse(extendShare('sess-1', H, 0).expiresAt)).toBe(25 * H);
    expect(Date.parse(extendShare('sess-1', H, 100 * H).expiresAt)).toBe(101 * H);
  });
  it('expire makes it expired now', () => {
    publish({ ...base, srcs: [file('a.md')], title: 'A', now: 0 });
    const s = expireShare('sess-1', 10);
    expect(isExpired(s, 10)).toBe(true);
    expect(isExpired(s, 9)).toBe(false);
  });
  it('throws for unknown shares', () => {
    expect(() => extendShare('nope', H)).toThrow(/no such share/);
  });
});

describe('listing and urls', () => {
  it('sorts by most recent publish and builds encoded urls', () => {
    publish({ ...base, srcs: [file('a.md')], title: 'A', now: 1000 });
    publish({ sessionId: 'sess-2', projectPath: '/w/q', srcs: [file('my plan #1.md')], title: 'B', now: 2000 });
    const list = listShares();
    expect(list.map((s) => s.id)).toEqual(['sess-2', 'sess-1']);
    const s = list[0];
    expect(shareUrl(s)).toBe(`https://ex.test/share/sess-2/${s.token}/`);
    expect(itemUrl(s, s.items[0])).toBe(`https://ex.test/share/sess-2/${s.token}/my%20plan%20%231.md`);
  });
  it('treats a corrupt share.json as missing', () => {
    fs.mkdirSync(path.join(shares, 'bad'), { recursive: true });
    fs.writeFileSync(path.join(shares, 'bad', 'share.json'), '{oops');
    expect(readShare('bad')).toBeNull();
    expect(listShares()).toEqual([]);
  });
});

describe('purge', () => {
  it('deletes expired shares only, or one by id', () => {
    publish({ ...base, srcs: [file('a.md')], title: 'A', now: 0 });
    publish({ sessionId: 'sess-2', srcs: [file('b.md')], title: 'B', now: Date.now() });
    expect(purge({ expired: true })).toEqual(['sess-1']);
    expect(readShare('sess-2')).not.toBeNull();
    expect(purge({ id: 'sess-2' })).toEqual(['sess-2']);
    expect(listShares()).toEqual([]);
  });
});

describe('resolveInside', () => {
  it('allows files inside and rejects escapes and private files', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(path.join(root, 'd'), { recursive: true });
    fs.writeFileSync(path.join(root, 'd', 'f.txt'), 'x');
    fs.writeFileSync(path.join(root, 'share.json'), '{}');
    fs.writeFileSync(path.join(root, '.hidden'), 'x');
    fs.writeFileSync(path.join(tmp, 'secret'), 'x');
    fs.symlinkSync(path.join(tmp, 'secret'), path.join(root, 'link'));
    expect(resolveInside(root, 'd/f.txt')).toBe(fs.realpathSync(path.join(root, 'd', 'f.txt')));
    expect(resolveInside(root, '')).toBe(fs.realpathSync(root));
    for (const bad of ['../secret', 'd/../../secret', '/etc/passwd', 'link', 'share.json', '.hidden', 'd/.x', 'missing']) {
      expect(resolveInside(root, bad), bad).toBeNull();
    }
  });
});

describe('time formatting', () => {
  it('shows times in Bucharest local time with the zone', () => {
    expect(formatLocal('2026-10-02T11:27:00Z')).toBe('2026-10-02 14:27 EEST');
    expect(formatLocal('2026-12-02T11:27:00Z')).toBe('2026-12-02 13:27 EET');
  });
  it('rounds the time left without ever printing 60 minutes', () => {
    expect(formatLeft(24 * H - 20e3)).toBe('in 24h 0m');
    expect(formatLeft(59.9 * 60e3)).toBe('in 1h 0m');
    expect(formatLeft(5 * 60e3)).toBe('in 5m');
    expect(formatLeft(0)).toBe('expired');
  });
});
