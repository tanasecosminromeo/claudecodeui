import { useCallback, useRef } from 'react';

import { api } from '@/shared/api';
import type { Project } from '@/shared/types';

type FileNode = {
  type: 'file' | 'directory';
  name: string;
  path: string;
  children?: FileNode[];
};

type FlatFile = {
  name: string;
  path: string;
};

// `diffInfo` is intentionally `any` so this resolver can wrap editor handlers
// that expect a concrete diff payload type as well as generic callers.
type OnFileOpen = (filePath: string, diffInfo?: any, line?: number | null) => void;

// The resolver's own handler also takes the message's path hints.
type ResolvingFileOpen = (
  filePath: string,
  diffInfo?: any,
  line?: number | null,
  searchHints?: string[],
) => void;

/**
 * A reference that names no readable file. `blockedPath` is set when one of
 * the guesses exists but lies outside the project and the read-only roots.
 */
export type UnresolvedFileReference = {
  reference: string;
  blockedPath: string | null;
};

type ResolveResponse = { path: string | null; blockedPath: string | null };

const normalize = (value: string): string => value.replace(/\\/g, '/');

// Backslashes are already normalized above, so a Windows path arrives as
// `C:/…`; counting it as absolute lets a Windows server resolve it as-is and a
// POSIX one answer an honest 404 instead of opening some other file. `~/` is
// the home directory, which the server expands.
const isAbsoluteRef = (value: string): boolean => /^(\/|~\/|[A-Za-z]:\/)/.test(value);

const basename = (value: string): string => value.replace(/\/+$/, '').split('/').pop() || value;

// Where a reference the project tree does not hold might be: the reference as
// given (an absolute path, or one the tree hides, e.g. gitignored), then for
// each path its message mentions, that path itself when it names the same file
// and the reference placed inside it when it is a folder. The server keeps the
// first readable one, so a guess that is not a folder costs only a stat.
export const buildCandidates = (ref: string, searchHints: string[] = []): string[] => {
  const candidates = [ref];
  if (isAbsoluteRef(ref)) {
    return candidates;
  }
  const relative = ref.replace(/^\.\//, '');
  const name = basename(relative);
  for (const hint of searchHints) {
    const directory = normalize(hint).replace(/\/+$/, '');
    if (!directory) {
      continue;
    }
    if (basename(directory) === name) {
      candidates.push(directory);
    }
    candidates.push(`${directory}/${relative}`);
  }
  return [...new Set(candidates)];
};

const flatten = (nodes: FileNode[], out: FlatFile[]): void => {
  for (const node of nodes) {
    if (node.type === 'file') {
      out.push({ name: node.name, path: node.path });
    } else if (node.children && node.children.length > 0) {
      flatten(node.children, out);
    }
  }
};

// References inside chat messages are often bare basenames (`foo.ts`) or partial
// paths (`utils/foo.ts`) rather than full paths, so match by path suffix and
// fall back to filename equality.
const findBestMatch = (files: FlatFile[], ref: string): string | null => {
  const target = normalize(ref).replace(/^\.\//, '').replace(/^\/+/, '');
  if (!target) {
    return null;
  }

  const suffixMatch = files.find((file) => {
    const filePath = normalize(file.path);
    return filePath === target || filePath.endsWith(`/${target}`);
  });
  if (suffixMatch) {
    return suffixMatch.path;
  }

  const base = target.split('/').pop() || target;
  return files.find((file) => file.name === base)?.path ?? null;
};

/**
 * Wraps an `onFileOpen` handler so a possibly bare/partial file reference is
 * resolved before the file is opened in the in-app editor: against the
 * project's file tree (cached per project) first, then by asking the server
 * which guess is a readable file. A reference that names none goes to
 * `onUnresolved` rather than opening an editor on a file that is not there.
 */
export function useFileOpenResolver(
  selectedProject: Project | null | undefined,
  onFileOpen: OnFileOpen,
  onUnresolved?: (unresolved: UnresolvedFileReference) => void,
): ResolvingFileOpen {
  const projectId = selectedProject?.projectId;
  const cacheRef = useRef<{ projectId?: string; files: Promise<FlatFile[]> | null }>({
    projectId: undefined,
    files: null,
  });

  const loadFiles = useCallback((): Promise<FlatFile[]> => {
    if (!projectId) {
      return Promise.resolve([]);
    }
    if (cacheRef.current.projectId === projectId && cacheRef.current.files) {
      return cacheRef.current.files;
    }

    const filesPromise = (async () => {
      try {
        const response = await api.getFiles(projectId);
        if (!response.ok) {
          return [];
        }
        const data = await response.json();
        const tree: FileNode[] = Array.isArray(data) ? data : [];
        const flat: FlatFile[] = [];
        flatten(tree, flat);
        return flat;
      } catch {
        return [];
      }
    })();

    cacheRef.current = { projectId, files: filesPromise };
    return filesPromise;
  }, [projectId]);

  const resolveOnServer = useCallback(
    async (candidates: string[]): Promise<ResolveResponse | null> => {
      if (!projectId) {
        return null;
      }
      try {
        const response = await api.resolveFile(projectId, candidates);
        return response.ok ? ((await response.json()) as ResolveResponse) : null;
      } catch {
        return null;
      }
    },
    [projectId],
  );

  return useCallback(
    (filePath: string, diffInfo?: any, line?: number | null, searchHints?: string[]) => {
      // Normalized once and used for every outcome: a reference picked up from
      // link text can carry surrounding whitespace, which the API would take as
      // part of the filename and answer with a 404.
      const ref = normalize(filePath).trim();
      void (async () => {
        // An absolute path already names one exact file: matching it against
        // the tree can only send it somewhere else — `~/.config/NOTES.md`
        // used to fall through to the filename match and silently open the
        // project's own `NOTES.md`.
        if (!isAbsoluteRef(ref)) {
          const match = findBestMatch(await loadFiles(), ref);
          if (match) {
            onFileOpen(match, diffInfo, line);
            return;
          }
        }

        const resolved = await resolveOnServer(buildCandidates(ref, searchHints));
        if (resolved?.path) {
          onFileOpen(resolved.path, diffInfo, line);
        } else if (resolved && onUnresolved) {
          onUnresolved({ reference: ref, blockedPath: resolved.blockedPath });
        } else {
          // No answer from the server (offline, or one without the resolve
          // endpoint): open the reference as given, as before, and let the
          // editor report what the read says.
          onFileOpen(ref, diffInfo, line);
        }
      })();
    },
    [loadFiles, onFileOpen, onUnresolved, resolveOnServer],
  );
}
