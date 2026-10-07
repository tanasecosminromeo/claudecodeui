// A message often names a folder once and then links its files by name alone:
// "Two reports, both under `~/work/play/files/`: [report.html](report.html)".
// The link by itself cannot be found, so the absolute paths the message
// mentions travel with it as places to look.

// An absolute or `~/` path, starting where a word could: line start, space,
// backtick, quote or opening bracket. A URL's `//host/…` is never preceded by
// one of those (it follows a `:`), so links to the web are not picked up.
const ABSOLUTE_PATH = /(?:^|[\s`'"(<[])((?:~\/|\/)[^\s`'"()<>[\]]+)/g;

// Sentence punctuation the path regex swallows: "saved in /tmp/out." is `/tmp/out`.
const TRAILING_PUNCTUATION = /[.,:;!?]+$/;

// Enough for any real message; it bounds the candidates sent to the server.
const MAXIMUM_HINTS = 10;

/** The distinct absolute and `~/` paths a markdown message mentions, first seen first. */
export function extractPathHints(markdown: string): string[] {
  const hints: string[] = [];
  for (const match of markdown.matchAll(ABSOLUTE_PATH)) {
    const hint = match[1].replace(TRAILING_PUNCTUATION, '');
    if (hint.length > 1 && hint !== '~/' && !hints.includes(hint)) {
      hints.push(hint);
      if (hints.length === MAXIMUM_HINTS) {
        break;
      }
    }
  }
  return hints;
}
