import type { FileTreeNode } from '@/shared/types';

// A reference written inside a chat message carries neither a canonical
// separator nor a canonical shape, so trailing slashes, `./` prefixes and
// Windows separators are levelled before anything is compared.
const normalizePath = (value: string): string =>
  value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

const isAbsolutePath = (value: string): boolean => /^(\/|[A-Za-z]:\/)/.test(value);

/**
 * The paths to expand, root first, so `reference` becomes visible in the file
 * tree; empty when the reference is not inside the loaded tree.
 *
 * Each level is looked up by name in the tree that is already loaded, rather
 * than composed as a string: an in-chat reference is usually relative
 * (`decisions/`, as the model wrote it) while every node is keyed by the
 * absolute path the server built with its own platform separator. Expansion
 * stops at the last level actually present, so a folder hidden by `.gitignore`
 * or below the walk depth still opens as far as the tree goes.
 */
export function directoryRevealPaths(
  files: FileTreeNode[],
  projectPath: string,
  reference: string,
): string[] {
  const root = normalizePath(projectPath);
  const target = normalizePath(reference);

  let relative = target;
  if (isAbsolutePath(target)) {
    if (!target.startsWith(`${root}/`)) {
      // Either the project root itself (nothing to expand) or a path outside
      // it — `/workspace/apple` must not be read as a child of `/workspace/app`.
      return [];
    }
    relative = target.slice(root.length + 1);
  }

  const paths: string[] = [];
  let level = files;
  for (const segment of relative.split('/').filter(Boolean)) {
    const directory = level.find((node) => node.type === 'directory' && node.name === segment);
    if (!directory) {
      break;
    }
    paths.push(directory.path);
    level = directory.children ?? [];
  }

  return paths;
}

// Folds `.` and `..` segments; `..` never climbs above the first segment, which
// for an absolute path is the empty string before its leading `/`.
const collapseDotSegments = (value: string): string => {
  const segments: string[] = [];
  for (const segment of value.split('/')) {
    if (segment === '.' || (segment === '' && segments.length > 0)) {
      continue;
    }
    if (segment === '..') {
      if (segments.length > 1) {
        segments.pop();
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/') || '/';
};

/**
 * The folder to show read-only when `reference` lies outside the project, or
 * `null` when it is inside it and is revealed in the project's own tree.
 *
 * A relative reference is placed against the project root, so `../other/` is
 * outside. A `~/` one is passed on as written: only the server knows whose
 * home that is, and it expands it when listing.
 */
export function outsideProjectDirectory(projectPath: string, reference: string): string | null {
  const target = reference.replace(/\\/g, '/').replace(/\/+$/, '');
  if (target === '~' || target.startsWith('~/')) {
    return target;
  }

  const root = normalizePath(projectPath);
  const absolute = collapseDotSegments(isAbsolutePath(target) ? target : `${root}/${target}`);
  return absolute === root || absolute.startsWith(`${root}/`) ? null : absolute;
}
