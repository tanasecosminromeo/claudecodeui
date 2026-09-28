#!/usr/bin/env bash
# Injects the custom layer (ui-cleanup, env-switcher) into CloudCLI UI's built dist/index.html
# via inject-html.mjs, then syncs the custom/ plugins. Idempotent; run before every server start
# (systemd ExecStartPre / launchd service script) so it survives `npm run build`.
# Never fails the start: always exits 0.
set -uo pipefail
trap 'echo "ui-cleanup: failed at line $LINENO, continuing without it" >&2; exit 0' ERR

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="${1:-$(cd "$SRC/../.." && pwd)}"  # repo root (custom/ui-cleanup/../..)

node "$SRC/inject-html.mjs" "$APP" || echo "ui-cleanup: injection skipped, continuing" >&2

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
