import os from 'node:os';
import path from 'node:path';

import type { Response } from 'express';

import { isProtectedPath } from '@/shared/protected-paths.js';

const PROTECTED_NOTICE = 'Protected: may contain keys. Contents hidden.';

/**
 * Env, key and credential files: Source Control lists them but never sends
 * their contents or diffs, as the file viewer does (`@/shared/protected-paths`).
 * Answers 403 PROTECTED_FILE and returns true when the file is one of them.
 */
export function refuseProtectedFile(
  res: Response,
  repositoryRootPath: string,
  repositoryRelativeFilePath: string,
  homeDirectory = os.homedir(),
): boolean {
  if (!isProtectedPath(path.join(repositoryRootPath, repositoryRelativeFilePath), homeDirectory)) {
    return false;
  }
  res.status(403).json({ error: PROTECTED_NOTICE, code: 'PROTECTED_FILE' });
  return true;
}

/**
 * A whole-commit patch keeps each protected file's header (so the change is
 * visible) but replaces its hunks with one line saying they are hidden.
 */
export function hideProtectedPatchSections(
  patch: string,
  repositoryRootPath: string,
  homeDirectory = os.homedir(),
): string {
  return patch.split(/(?=^diff --git )/m).map((section) => {
    const header = section.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const files = header ? [header[1], header[2]] : [];
    if (!files.some((file) => isProtectedPath(path.join(repositoryRootPath, file), homeDirectory))) {
      return section;
    }
    const firstHunk = section.search(/^@@ |^Binary files |^GIT binary patch/m);
    const head = firstHunk === -1 ? section : section.slice(0, firstHunk);
    return `${head}(${PROTECTED_NOTICE})\n`;
  }).join('');
}
