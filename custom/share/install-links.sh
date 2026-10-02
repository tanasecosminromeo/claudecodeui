#!/usr/bin/env bash
# Link the `share` CLI and the `publish` skill into $HOME (run by `make share-install`).
# A link from an older checkout is replaced quietly; a real file or folder in the way is only
# moved aside (to <name>.bak-<timestamp>) after an explicit yes.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

link() {
  local target=$1 dst=$2
  mkdir -p "$(dirname "$dst")"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    local kind=file; [ -d "$dst" ] && kind=folder
    local bak
    bak="$dst.bak-$(date +%Y%m%d-%H%M%S)"
    printf 'share-install: %s is a real %s, not a link.\nMove it to %s and link %s there instead? [y/N] ' \
      "$dst" "$kind" "$bak" "$target"
    local ans=''
    read -r ans || true
    case "$ans" in
      y|Y|yes|YES) mv "$dst" "$bak"; echo "share-install: moved to $bak" ;;
      *) echo; echo "share-install: left $dst as it is; nothing linked" >&2; exit 1 ;;
    esac
  fi
  ln -sfn "$target" "$dst"
  echo "share-install: $dst -> $target"
}

link "$SRC/skill" "$HOME/.claude/skills/publish"
link "$SRC/share.mjs" "$HOME/.local/bin/share"
