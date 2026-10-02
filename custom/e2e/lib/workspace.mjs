// Where the app under test is built. Never the live checkout: building there
// rewrites dist/, which the running live service serves — its UI would change
// under it against an old backend. Instead the checkout's current state,
// uncommitted changes included, is mirrored into a dedicated git worktree and
// built there.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function run(cwd, command, args, log) {
  log(`$ (${path.basename(cwd)}) ${command} ${args.join(' ')}`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

/**
 * The e2e worktree: `claudecodeui-worktrees/e2e` next to the main checkout. Found through git's
 * common dir, so a run from a linked worktree (itself under claudecodeui-worktrees/) reuses the same
 * folder instead of nesting a new one inside the worktrees folder.
 */
export function defaultWorktreeDir(repoDir) {
  const common = path.resolve(repoDir, git(repoDir, 'rev-parse', '--git-common-dir').trim());
  return path.join(path.dirname(path.dirname(common)), 'claudecodeui-worktrees', 'e2e');
}

/**
 * Makes `worktreeDir` an exact copy of `sourceDir`'s working tree — HEAD plus
 * staged, unstaged and untracked (non-ignored) changes — installs
 * dependencies when package-lock.json changed, and builds it.
 */
export function prepareWorkspace({ sourceDir, worktreeDir, log }) {
  const head = git(sourceDir, 'rev-parse', 'HEAD').trim();

  if (!fs.existsSync(path.join(worktreeDir, '.git'))) {
    log(`creating worktree ${worktreeDir}`);
    git(sourceDir, 'worktree', 'add', '--detach', worktreeDir, head);
  }

  // Back to a clean HEAD (ignored folders — node_modules, dist — are kept).
  git(worktreeDir, 'checkout', '--detach', '--force', head);
  git(worktreeDir, 'reset', '--hard', '-q', head);
  git(worktreeDir, 'clean', '-fdq');

  // Tracked changes, staged and unstaged, as one patch against HEAD.
  const patch = execFileSync('git', ['-C', sourceDir, 'diff', 'HEAD', '--binary'], { maxBuffer: 256 * 1024 * 1024 });
  if (patch.length > 0) {
    execFileSync('git', ['-C', worktreeDir, 'apply', '--whitespace=nowarn', '-'], { input: patch });
  }
  // New files that are not ignored.
  const untracked = git(sourceDir, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  for (const file of untracked) {
    const target = path.join(worktreeDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceDir, file), target);
  }
  log(`mirrored ${sourceDir} @ ${head.slice(0, 8)} (+${patch.length ? 'changes' : 'no changes'}, ${untracked.length} untracked) into ${worktreeDir}`);

  // Dependencies only when the lockfile changed since the last install.
  const lockHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(worktreeDir, 'package-lock.json'))).digest('hex');
  const stamp = path.join(worktreeDir, 'node_modules', '.e2e-lock-hash');
  const installed = fs.existsSync(stamp) ? fs.readFileSync(stamp, 'utf8') : '';
  if (installed !== lockHash) {
    run(worktreeDir, 'npm', ['ci', '--include=dev', '--no-audit', '--no-fund'], log);
    fs.writeFileSync(stamp, lockHash);
  }

  run(worktreeDir, 'npm', ['run', 'build'], log);
  return worktreeDir;
}
