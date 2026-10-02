// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultWorktreeDir } from '../lib/workspace.mjs';

let tmp; let main; let linked;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ws-')));
  main = path.join(tmp, 'claudecodeui');
  fs.mkdirSync(main);
  git(main, 'init', '-q');
  git(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  linked = path.join(tmp, 'claudecodeui-worktrees', 'feature');
  git(main, 'worktree', 'add', '-q', '--detach', linked);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('defaultWorktreeDir', () => {
  it('sits next to the main checkout', () => {
    expect(defaultWorktreeDir(main)).toBe(path.join(tmp, 'claudecodeui-worktrees', 'e2e'));
  });

  it('is the same folder when run from a linked worktree, never one nested inside the worktrees folder', () => {
    expect(defaultWorktreeDir(linked)).toBe(path.join(tmp, 'claudecodeui-worktrees', 'e2e'));
  });
});
