# claude-guard: a `claude` that asks before resuming a session another process
# already has open — the CloudCLI chat, another terminal, an IDE. Two processes
# on one session both append to its transcript and fork the conversation.
#
# Every Claude Code process registers itself in ~/.claude/sessions/<pid>.json
# with the session it is on; this reads those. Needs jq. Sourced from
# ~/.zshrc / ~/.bashrc by `make claude-guard`. Bypass with `command claude`.

claude() {
  local session_id="" previous="" arg
  for arg in "$@"; do
    case "$previous" in -r|--resume) session_id="$arg" ;; esac
    case "$arg" in --resume=*) session_id="${arg#--resume=}" ;; esac
    previous="$arg"
  done

  if [ -n "$session_id" ] && command -v jq >/dev/null 2>&1; then
    [ -n "$ZSH_VERSION" ] && setopt local_options null_glob
    local registry="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/sessions" file pid entrypoint where=""
    for file in "$registry"/*.json; do
      [ -e "$file" ] || continue
      pid=$(jq -r --arg id "$session_id" 'select(.sessionId == $id) | .pid // empty' "$file" 2>/dev/null)
      [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || continue
      entrypoint=$(jq -r '.entrypoint // ""' "$file" 2>/dev/null)
      case "$entrypoint" in
        sdk-ts) where="$where\n  - the CloudCLI chat (pid $pid)" ;;
        cli) where="$where\n  - another terminal (pid $pid)" ;;
        *) where="$where\n  - ${entrypoint:-another Claude app} (pid $pid)" ;;
      esac
    done
    if [ -n "$where" ]; then
      printf "This session is already running in:$where\nA second copy would fork the conversation.\n"
      printf 'Open a second copy anyway? [y/N] '
      local answer
      read -r answer
      case "$answer" in y|Y) ;; *) return 1 ;; esac
    fi
  fi

  command claude "$@"
}
