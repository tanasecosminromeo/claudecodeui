#!/usr/bin/env bash
# Injects cleanup.css + cleanup.js into CloudCLI UI's built dist/index.html.
# Idempotent; run before every server start (ExecStartPre in claudecodeui.service)
# so it survives `npm run build`. Never fails the start: always exits 0.
set -uo pipefail
trap 'echo "ui-cleanup: failed at line $LINENO, continuing without it" >&2; exit 0' ERR

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${1:-$(cd "$SRC/../.." && pwd)}"  # repo root (custom/ui-cleanup/../..)
INDEX="$APP/dist/index.html"
OUT="$APP/dist/ui-cleanup"

if [ ! -f "$INDEX" ]; then
  echo "ui-cleanup: $INDEX not found (not built yet?), skipping" >&2
  exit 0
fi

# Content-hashed names: the server serves JS/CSS with a 1-year immutable cache.
css_hash=$(sha256sum "$SRC/cleanup.css" | cut -c1-10)
js_hash=$(sha256sum "$SRC/cleanup.js" | cut -c1-10)
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$SRC/cleanup.css" "$OUT/cleanup.$css_hash.css"
cp "$SRC/cleanup.js" "$OUT/cleanup.$js_hash.js"
[ -d "$SRC/fonts" ] && cp -r "$SRC/fonts" "$OUT/fonts"

tmp=$(mktemp)
sed '/<!-- ui-cleanup:start -->/d' "$INDEX" > "$tmp"
block="<!-- ui-cleanup:start --><link rel=\"preload\" href=\"/ui-cleanup/fonts/MesloLGS-NF-Regular.woff2\" as=\"font\" type=\"font/woff2\" crossorigin /><link rel=\"preload\" href=\"/ui-cleanup/fonts/MesloLGS-NF-Bold.woff2\" as=\"font\" type=\"font/woff2\" crossorigin /><link rel=\"stylesheet\" href=\"/ui-cleanup/cleanup.$css_hash.css\" /><script defer src=\"/ui-cleanup/cleanup.$js_hash.js\"></script><!-- ui-cleanup:end -->"
grep -q '</head>' "$tmp"
sed -i "s#</head>#${block}\n</head>#" "$tmp"
cat "$tmp" > "$INDEX"
rm -f "$tmp"
echo "ui-cleanup: injected css=$css_hash js=$js_hash into $INDEX"

# Install/refresh every CloudCLI plugin under custom/ (any dir with a manifest.json).
# CloudCLI skips symlinked plugin dirs, so each one is a real copy.
CUSTOM="$(cd "$SRC/.." && pwd)"
for manifest in "$CUSTOM"/*/manifest.json; do
  [ -f "$manifest" ] || continue
  dir="$(dirname "$manifest")"
  name="$(node -e 'process.stdout.write(require(process.argv[1]).name)' "$manifest")"
  case "$name" in ''|*[!a-zA-Z0-9_-]*) echo "ui-cleanup: skipping $dir (bad plugin name)" >&2; continue ;; esac
  dst="$HOME/.claude-code-ui/plugins/$name"
  mkdir -p "$dst"
  find "$dir" -maxdepth 1 -type f ! -name 'README.md' -exec cp -f {} "$dst"/ \;
  echo "ui-cleanup: synced plugin $name to $dst"
done
