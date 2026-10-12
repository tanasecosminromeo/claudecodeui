import assert from 'node:assert/strict';
import test from 'node:test';

import { isProtectedOrLinksToProtected, isProtectedPath } from '@/shared/protected-paths.js';

const HOME = '/users/someone';
const OTHER_HOME = '/users/someone-else';
const inProject = (name: string) => `/srv/project/${name}`;

test('env files are protected, whatever comes before or after .env', () => {
  for (const name of [
    '.env', '.env.local', '.env.common', '.env.test', '.env.example', '.env.dist', '.env.template',
    'local.env', 'jira.env', '.node1.env', '.migration.env', '.migration.env.dist', 'local.env.example',
    '.envrc', 'PROD.ENV',
  ]) {
    assert.equal(isProtectedPath(inProject(name), HOME), true, name);
  }
});

test('code and folders that merely mention env stay visible', () => {
  for (const name of [
    'load-env.ts', 'vite-env.d.ts', 'env.ts', 'env.sh', 'generate-env.sh', 'prompt_env.sh', 'Envelope.php',
    'EnvVarProcessor.php', 'Dotenv.php', 'ggml-openvino.cpp', 'pyvenv.cfg', '.venv', 'env-switcher', 'environment.ts',
    'README.md', 'package.json',
  ]) {
    assert.equal(isProtectedPath(inProject(name), HOME), false, name);
  }
});

test('key and signing files are protected; public ssh keys are not', () => {
  for (const name of ['server.pem', 'tls.key', 'cert.p12', 'cert.pfx', 'AuthKey.p8', 'release.jks', 'upload.keystore', 'secret.gpg', 'id_rsa', 'id_ed25519', 'id_ed25519_github']) {
    assert.equal(isProtectedPath(inProject(name), HOME), true, name);
  }
  for (const name of ['id_rsa.pub', 'id_ed25519.pub', 'keys.md', 'monkey.ts']) {
    assert.equal(isProtectedPath(inProject(name), HOME), false, name);
  }
});

test('credential stores in the home directory are protected', () => {
  for (const relative of [
    '.ssh/config', '.ssh/known_hosts', '.ssh', '.gnupg/pubring.kbx', '.aws/credentials', '.kube/config',
    '.docker/config.json', '.claude/.credentials.json', '.config/gh/hosts.yml', '.local/share/opencode/auth.json',
    '.netrc', '.npmrc', '.pypirc', '.pgpass', '.git-credentials',
  ]) {
    assert.equal(isProtectedPath(`${HOME}/${relative}`, HOME), true, relative);
  }
  for (const relative of ['.sshrc-notes/readme.md', '.claude/settings.json', '.config/gh/config.yml', '.docker/notes.json']) {
    assert.equal(isProtectedPath(`${HOME}/${relative}`, HOME), false, relative);
  }
});

test('a home folder rule does not reach another user or a look-alike folder', () => {
  assert.equal(isProtectedPath(`${OTHER_HOME}/.ssh/config`, HOME), false);
  assert.equal(isProtectedPath(`${HOME}/projects/.ssh-notes.md`, HOME), false);
});

test('a symlink to a protected file is protected too', async () => {
  const realpath = async (target: string) => (target === inProject('notes.txt') ? `${HOME}/.ssh/id_ed25519` : target);
  assert.equal(await isProtectedOrLinksToProtected(inProject('notes.txt'), HOME, realpath), true);
  assert.equal(await isProtectedOrLinksToProtected(inProject('readme.txt'), HOME, realpath), false);
});

test('a path that cannot be resolved is judged by its own name', async () => {
  const realpath = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  assert.equal(await isProtectedOrLinksToProtected(inProject('readme.txt'), HOME, realpath), false);
  assert.equal(await isProtectedOrLinksToProtected(inProject('.env'), HOME, realpath), true);
});
