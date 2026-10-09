// Paths a chat message mentions outside markdown links, so they open like
// links do: in inline code (`/srv/app/main.py:40`), read generously because
// that is where a model quotes a path, and in plain text, read strictly
// because prose is full of slashes and dots that are not paths ("and/or",
// "1/2", "Node.js").

// Extensions a bare name (`README.md`) or a relative path in prose
// (`src/foo.ts`) must end in to count as a file. Code identifiers such as
// `JSON.parse` or `this.state` end in none of these.
const KNOWN_EXTENSIONS = new Set([
  'md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'log', 'out', 'output', 'err',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro',
  'py', 'pyi', 'ipynb', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift', 'm', 'mm',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'php', 'pl', 'lua', 'r', 'dart', 'ex', 'exs', 'erl', 'hs', 'zig',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'prisma', 'graphql', 'gql', 'proto',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'xml', 'svg', 'xsl',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'pdf',
  'csv', 'tsv', 'xlsx', 'docx', 'pptx',
  'lock', 'patch', 'diff', 'service', 'timer', 'socket', 'desktop',
  'dockerfile', 'tf', 'tfvars', 'hcl', 'nix', 'gradle', 'cmake', 'mk',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z',
  'mp3', 'mp4', 'wav', 'webm', 'mov', 'ogg',
]);

// Files that carry no extension yet are plainly files when quoted in code.
const KNOWN_FILE_NAMES = new Set([
  'Makefile', 'Dockerfile', 'Containerfile', 'Procfile', 'Gemfile', 'Rakefile', 'Justfile', 'LICENSE',
]);

// One path: the characters a path is made of, then an optional `:line` or
// `:line:col`. Brackets, quotes, `*`, `$`, `|` and the like are excluded, so a
// glob, a variable or a pipeline is never mistaken for a path.
const PATH_BODY = String.raw`[\w.@%+=,~/-]+`;
const LINE_SUFFIX = String.raw`(?::\d+(?::\d+)?)?`;
const INLINE_CODE_PATH = new RegExp(`^(${PATH_BODY})(${LINE_SUFFIX})$`);

// In prose a path starts where a word can: the start, a space or an opening
// bracket or quote. That keeps `https://host/…` out (its `//` follows a `:`)
// as well as the second half of `and/or`.
const TEXT_PATH = new RegExp(`(?<=^|[\\s([{<"'])(${PATH_BODY})(${LINE_SUFFIX})`, 'g');

// What may follow a path in prose. Anything else (`a.b(c)`) means the match
// was the start of something that is not a path.
const PATH_END = /^(?:$|[\s.,;:!?)\]}>"'])/;

// Sentence punctuation the body swallows: "saved in /tmp/out." is `/tmp/out`.
const TRAILING_PUNCTUATION = /[.,]+$/;

// `https:`, `mailto:`, `file:` — but not `Markdown.tsx:291`, a line suffix.
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:(?!\d)/i;

// "Node.js", "Next.js": a capitalized name ending in `.js` is a library in prose.
const LIBRARY_NAME = /^[A-Z][A-Za-z]*\.js$/;

const extensionOf = (name: string): string | null => {
  const match = name.match(/\.([A-Za-z0-9]+)$/);
  return match && match.index !== 0 ? match[1].toLowerCase() : null;
};

const hasKnownExtension = (name: string): boolean => {
  const extension = extensionOf(name);
  return extension !== null && KNOWN_EXTENSIONS.has(extension);
};

const lastSegment = (filePath: string): string => filePath.replace(/\/+$/, '').split('/').pop() ?? '';

// `/srv/app` or `/notes.md`, never `/compact` (a slash command) or `//host`.
const isAbsolutePath = (filePath: string): boolean => {
  if (!filePath.startsWith('/') || filePath.startsWith('//')) {
    return false;
  }
  const segments = filePath.split('/').filter(Boolean);
  return segments.length >= 2 || (segments.length === 1 && hasKnownExtension(segments[0]));
};

const isHomeOrDotRelativePath = (filePath: string): boolean =>
  /^(?:~|\.{1,2})\/./.test(filePath);

/**
 * The file reference an inline code span holds, `:line` suffix included, or
 * `null` when it is not one path. Absolute, `~/`, `./` and `../` paths count,
 * as does any relative path with a `/` in it (`src/modules`, `docs/`) and a
 * bare name with a known extension (`package.json`).
 */
export function inlineCodeFileReference(code: string): string | null {
  const value = code.trim();
  if (!value || URL_SCHEME.test(value) || value.startsWith('-')) {
    return null;
  }
  const match = value.match(INLINE_CODE_PATH);
  if (!match) {
    return null;
  }
  const filePath = match[1];
  if (!/[A-Za-z]/.test(filePath)) {
    // `1/2`, `10/09/2026`, `3.14`.
    return null;
  }

  if (filePath.startsWith('/')) {
    return isAbsolutePath(filePath) ? value : null;
  }
  if (isHomeOrDotRelativePath(filePath)) {
    return value;
  }
  if (filePath.includes('/')) {
    // A trailing slash marks a folder; an empty segment anywhere else does not
    // make a path.
    return filePath.replace(/\/$/, '').split('/').every(Boolean) ? value : null;
  }
  return hasKnownExtension(filePath) || KNOWN_FILE_NAMES.has(filePath) ? value : null;
}

const isTextPath = (filePath: string): boolean => {
  if (!/[A-Za-z]/.test(filePath)) {
    return false;
  }
  if (filePath.startsWith('/')) {
    return isAbsolutePath(filePath);
  }
  if (isHomeOrDotRelativePath(filePath)) {
    return true;
  }
  if (filePath.includes('/')) {
    // `example.com/docs/a.html` is a URL without its scheme, not a folder.
    const firstSegment = filePath.split('/')[0];
    return firstSegment.length > 0
      && !(firstSegment.includes('.') && !firstSegment.startsWith('.'))
      && hasKnownExtension(lastSegment(filePath));
  }
  return hasKnownExtension(filePath) && !LIBRARY_NAME.test(filePath);
};

export type TextFileReference = {
  /** Offset of the reference in the text. */
  start: number;
  /** Offset just past it. */
  end: number;
  /** The path as written, `:line` suffix included. */
  reference: string;
};

/**
 * The file paths a run of plain text mentions, in order: absolute (`/srv/x/y`),
 * `~/`, `./` and `../` paths, and relative paths or bare names that end in a
 * known extension (`src/foo.ts`, `README.md`). Trailing sentence punctuation is
 * not part of a path; a `:line` or `:line:col` suffix is.
 */
export function findTextFileReferences(text: string): TextFileReference[] {
  const references: TextFileReference[] = [];
  for (const match of text.matchAll(TEXT_PATH)) {
    const start = match.index ?? 0;
    let filePath = match[1];
    let suffix = match[2];
    const end = start + match[0].length;
    if (!PATH_END.test(text.slice(end))) {
      continue;
    }

    // "see /tmp/out." — the dot ends the sentence. With a suffix there is
    // nothing to strip: the body ended at its `:`.
    if (!suffix) {
      filePath = filePath.replace(TRAILING_PUNCTUATION, '');
      suffix = '';
    }
    if (!isTextPath(filePath)) {
      continue;
    }

    const reference = filePath + suffix;
    references.push({ start, end: start + reference.length, reference });
  }
  return references;
}
