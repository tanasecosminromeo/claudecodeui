// @vitest-environment node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../install-links.sh', import.meta.url));
const SHARE_DIR = path.dirname(SCRIPT);
let home; let skill; let bin;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'share-links-'));
  skill = path.join(home, '.claude', 'skills', 'publish');
  bin = path.join(home, '.local', 'bin', 'share');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const run = (input = '') => spawnSync('bash', [SCRIPT], { env: { ...process.env, HOME: home }, input, encoding: 'utf8' });

describe('install-links.sh', () => {
  it('links the skill and the CLI into a fresh home', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(fs.readlinkSync(skill)).toBe(path.join(SHARE_DIR, 'skill'));
    expect(fs.readlinkSync(bin)).toBe(path.join(SHARE_DIR, 'share.mjs'));
  });

  it('quietly replaces links left by another checkout', () => {
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.symlinkSync('/somewhere/old/skill', skill);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/\[y\/N\]/);
    expect(fs.readlinkSync(skill)).toBe(path.join(SHARE_DIR, 'skill'));
  });

  it('leaves a real folder alone and fails unless told yes', () => {
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'mine');
    for (const answer of ['', 'n\n', 'whatever\n']) {
      const r = run(answer);
      expect(r.status).toBe(1);
      expect(r.stdout + r.stderr).toMatch(/is a real folder/);
      expect(fs.lstatSync(skill).isDirectory()).toBe(true);
      expect(fs.readdirSync(skill)).toEqual(['SKILL.md']);
    }
  });

  it('moves a real folder aside on yes and links in its place', () => {
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), 'mine');
    const r = run('y\n');
    expect(r.status).toBe(0);
    expect(fs.readlinkSync(skill)).toBe(path.join(SHARE_DIR, 'skill'));
    const backups = fs.readdirSync(path.dirname(skill)).filter((n) => n.startsWith('publish.bak-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(skill), backups[0], 'SKILL.md'), 'utf8')).toBe('mine');
  });

  it('asks about a real file in place of the CLI too', () => {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/bin/sh\necho other share tool\n');
    const r = run('n\n');
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/is a real file/);
    expect(fs.readFileSync(bin, 'utf8')).toContain('other share tool');
  });
});
