# session-radar (CloudCLI plugin)

Shows Claude Code sessions on this host grouped **Needs you** > **Running** > **Idle** > **Ended (24h)**, each group sorted by last message (newest first). Appears as a "Sessions" workspace tab and, via `../ui-cleanup`, in the sidebar's Running view.

Data sources (all local, read-only):

- `~/.claude/sessions/<pid>.json`: Claude Code's own per-process status (`busy` / `idle` / `waiting` + `waitingFor`). Liveness is checked against `/proc/<pid>/stat` start time to ignore reused pids.
- Child shells sourcing `~/.claude/shell-snapshots/`: running Bash-tool work (background tasks, Monitors), shown as "N tasks running".
- `~/.claude/projects/*/<id>.jsonl` mtime: last message time, and sessions that already exited.
- `~/.cloudcli/auth.db` (read-only, `node:sqlite`): titles and the app session id CloudCLI routes on. UI-started chats have an app id different from Claude's id.
- `detail.mjs`, for live sessions only: memory (`VmRSS`, summed over the process tree), the commands of running Bash-tool children, and from the last 256 KB of the transcript the model, permission mode, git branch, context size and running agents (foreground agents without a result; background agents until their task-notification). Shown as chips in the row and in its tooltip, with a "N live · M GB" summary on top.

Stop (kill process) sends SIGTERM to a live session's pid after a second click; only pids from `~/.claude/sessions` whose start time still matches, owned by the same user.

A live process is always listed (even idle for days, or archived in CloudCLI). The "Ended · 24h" group is collapsed by default (remembered in localStorage).

Not covered: VS Code extension sessions don't write a status, so they only show via transcript activity. Codex/Cursor/OpenCode sessions aren't included.

Installed by `../ui-cleanup/inject.sh` at service start (CloudCLI ignores symlinked plugin dirs). Debug: `node server.mjs --dump`.
