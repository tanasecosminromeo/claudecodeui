# session-radar (CloudCLI plugin)

Shows Claude Code sessions on this host grouped **Needs you** > **Running** > **Idle** > **Ended (24h)**, each group sorted by last message (newest first). Appears as a "Sessions" workspace tab and, via `../ui-cleanup`, in the sidebar's Running view.

Data sources (all local, read-only):

- `~/.claude/sessions/<pid>.json`: Claude Code's own per-process status (`busy` / `idle` / `waiting` + `waitingFor`). Liveness is checked against `/proc/<pid>/stat` start time to ignore reused pids.
- Child shells sourcing `~/.claude/shell-snapshots/`: running Bash-tool work (background tasks, Monitors), shown as "N tasks running".
- `~/.claude/projects/*/<id>.jsonl` mtime: last message time, and sessions that already exited.
- `~/.cloudcli/auth.db` (read-only, `node:sqlite`): titles and the app session id CloudCLI routes on. UI-started chats have an app id different from Claude's id.

Not covered: VS Code extension sessions don't write a status, so they only show via transcript activity. Codex/Cursor/OpenCode sessions aren't included.

Installed by `../ui-cleanup/inject.sh` at service start (CloudCLI ignores symlinked plugin dirs). Debug: `node server.mjs --dump`.
