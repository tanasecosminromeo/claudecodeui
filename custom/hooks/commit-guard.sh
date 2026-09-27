#!/usr/bin/env bash
# commit-guard: keep secrets and denylisted terms (personal info, client names) out of git.
# Wired in from .husky/{pre-commit,commit-msg,pre-push}; see README.md.
#
#   commit-guard.sh staged      added lines + new file names in the index
#   commit-guard.sh msg <file>  a commit message
#   commit-guard.sh push        every commit being pushed that no remote has yet (reads pre-push stdin)
set -uo pipefail

DENYLIST="${COMMIT_GUARD_DENYLIST:-${XDG_CONFIG_HOME:-$HOME/.config}/commit-guard/denylist}"
ZERO=0000000000000000000000000000000000000000
SECRET_FILES='(^|/)(\.env(\.[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)|[^/]*\.(pem|key|p12|pfx|jks|kdbx)|credentials(\.json)?|auth\.db)$'

die() { printf 'commit-guard: %s\n' "$*" >&2; exit 1; }
[ -r "$DENYLIST" ] || die "denylist not found: $DENYLIST (see custom/hooks/README.md)"
command -v gitleaks >/dev/null || die "gitleaks not installed: https://github.com/gitleaks/gitleaks"

# Unified diff (stdin) -> "path:line: text" for every added line.
added() {
  awk '/^\+\+\+ /{f=substr($0,5); sub(/^b\//,"",f); next}
       /^@@/{split($3,a,/[+,]/); n=a[2]; next}
       /^\+/{print f ":" n ": " substr($0,2); n++}'
}

# Text (stdin) must hold no denylisted term and no secret. $1 labels the report.
check() {
  local text hits rc=0
  text=$(cat)
  if hits=$(printf '%s\n' "$text" | grep -iEf <(grep -vE '^[[:space:]]*(#|$)' "$DENYLIST")); then
    printf 'commit-guard: denylisted term in %s:\n%s\n' "$1" "$hits" >&2; rc=1
  fi
  if ! printf '%s\n' "$text" | gitleaks stdin --no-banner --redact --log-level error -v >&2; then
    printf 'commit-guard: gitleaks found a secret in %s (above)\n' "$1" >&2; rc=1
  fi
  return $rc
}

# File names (stdin) must not look like key/credential files. $1 labels the report.
check_names() {
  local hits
  if hits=$(grep -E "$SECRET_FILES" | grep -vE '\.(example|sample|template)$'); then
    printf 'commit-guard: secret-looking file in %s:\n%s\n' "$1" "$hits" >&2; return 1
  fi
}

# $1 label, $2 new file names, $3 unified diff.
scan() {
  local rc=0
  printf '%s\n' "$2" | check_names "$1" || rc=1
  { printf '%s\n' "$2"; printf '%s\n' "$3" | added; } | check "$1" || rc=1
  return $rc
}

case "${1:-}" in
  staged)
    # Mid-merge, diff against the incoming side so upstream's own changes aren't rescanned.
    base=HEAD
    git rev-parse -q --verify MERGE_HEAD >/dev/null && base=MERGE_HEAD
    git rev-parse -q --verify HEAD >/dev/null || base=$(git hash-object -t tree /dev/null)
    scan "staged changes" \
      "$(git diff --cached --name-only --diff-filter=ACR "$base")" \
      "$(git diff --cached -U0 --no-color --no-ext-diff "$base")" || die "commit blocked"
    ;;
  msg)
    grep -v '^#' "$2" | check "commit message" || die "commit blocked"
    ;;
  push)
    rc=0
    while read -r _ lsha _ _; do
      [ "$lsha" = "$ZERO" ] && continue
      # Commits already on any remote (upstream included) were either vetted or aren't ours.
      for c in $(git rev-list "$lsha" --not --remotes); do
        if git rev-parse -q --verify "$c^2" >/dev/null; then from="$c^2"; else from="$c^"; fi
        git rev-parse -q --verify "$from" >/dev/null || from=$(git hash-object -t tree /dev/null)
        git log -1 --format=%B "$c" | check "message of $(git rev-parse --short "$c")" || rc=1
        scan "commit $(git rev-parse --short "$c")" \
          "$(git diff --name-only --diff-filter=ACR "$from" "$c")" \
          "$(git diff -U0 --no-color --no-ext-diff "$from" "$c")" || rc=1
      done
    done
    [ $rc -eq 0 ] || die "push blocked"
    ;;
  *) die "usage: $0 staged | msg <file> | push" ;;
esac
