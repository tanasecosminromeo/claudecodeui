import path from 'node:path';

/**
 * Files whose contents the web UI never shows: env files, key and signing
 * files, and the credential stores in the home directory.
 *
 * Reading anywhere the server process may read is allowed, so these are held
 * back by name instead: the file tree still lists them (marked protected), and
 * every endpoint that would send their contents refuses with PROTECTED_FILE.
 * Claude itself is not affected: this guards what reaches the browser.
 */

// `.env`, `.env.local`, `.env.example`, `local.env`, `.migration.env.dist`…
// but not code that merely mentions env (`load-env.ts`, `env.sh`).
const ENV_FILE_NAME = /\.env(\.[^/]*)?$/i;
const PROTECTED_FILE_NAMES = new Set(['.envrc', '.netrc', '.npmrc', '.pypirc', '.pgpass', '.git-credentials']);
// Key, certificate-key and signing-store files.
const KEY_FILE_EXTENSION = /\.(pem|key|p12|pfx|p8|jks|keystore|gpg)$/i;
// SSH private keys; their `.pub` halves are public.
const SSH_PRIVATE_KEY_NAME = /^id_(rsa|ed25519|ecdsa|dsa)(?!.*\.pub$)/;

// Relative to the home directory: whole folders, then single files.
const PROTECTED_HOME_DIRECTORIES = ['.ssh', '.gnupg', '.aws', '.kube'];
const PROTECTED_HOME_FILES = [
  '.docker/config.json',
  '.claude/.credentials.json',
  '.config/gh/hosts.yml',
  '.local/share/opencode/auth.json',
];

function isInside(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Whether the UI must not show the contents of `absolutePath` (no symlink resolution: see `protectedPathOf`). */
export function isProtectedPath(absolutePath: string, homeDirectory: string): boolean {
  const resolved = path.resolve(absolutePath);
  const name = path.basename(resolved);
  if (PROTECTED_FILE_NAMES.has(name) || ENV_FILE_NAME.test(name)
    || KEY_FILE_EXTENSION.test(name) || SSH_PRIVATE_KEY_NAME.test(name)) {
    return true;
  }
  const home = path.resolve(homeDirectory);
  if (PROTECTED_HOME_DIRECTORIES.some((directory) => isInside(path.join(home, directory), resolved))) {
    return true;
  }
  return PROTECTED_HOME_FILES.some((file) => path.join(home, file) === resolved);
}

/**
 * The path as given or, when it is a symlink, the file it points to: either one
 * being protected protects both, so `notes.txt -> ~/.ssh/id_ed25519` is refused.
 */
export async function isProtectedOrLinksToProtected(
  absolutePath: string,
  homeDirectory: string,
  realpath: (target: string) => Promise<string>,
): Promise<boolean> {
  if (isProtectedPath(absolutePath, homeDirectory)) {
    return true;
  }
  try {
    return isProtectedPath(await realpath(absolutePath), homeDirectory);
  } catch {
    return false;
  }
}
