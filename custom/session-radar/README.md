# session-radar (CloudCLI plugin)

Shows Claude Code sessions on this host grouped **Needs you** > **Running** > **Idle** > **Ended (24h)**, each group sorted by last message (newest first). Appears as a "Sessions" workspace tab and, via `../ui-cleanup`, in the sidebar's Running view.

Data sources (all local, read-only):

- `~/.claude/sessions/<pid>.json`: Claude Code's own per-process status (`busy` / `idle` / `waiting` + `waitingFor`). Liveness is checked against `/proc/<pid>/stat` start time to ignore reused pids.
- Child shells sourcing `~/.claude/shell-snapshots/`: running Bash-tool work (background tasks, Monitors), shown as "N tasks running".
- `~/.claude/projects/*/<id>.jsonl` mtime: last message time, and sessions that already exited.
- `~/.cloudcli/auth.db` (read-only, `node:sqlite`): titles and the app session id CloudCLI routes on. UI-started chats have an app id different from Claude's id.
- `detail.mjs`, for live sessions only: memory (`VmRSS`, summed over the process tree), the commands of running Bash-tool children, and from the last 256 KB of the transcript the model, permission mode, git branch, context size and running agents (foreground agents without a result; background agents until their task-notification). While a session is `waiting`, `pending` names the request it waits on: the last main-thread tool call without a result (`{ tool, summary }`, the command, file or URL). Shown as chips in the row and in its tooltip, with a "N live · M GB" summary on top.

- `/var/log/agent-exec/<uid>.jsonl` (written by `../exec-tracer`, optional): every process a session
  started and its exit. `GET /tree?sid=<claude session id | pid:<n>>` merges it with the live `/proc`
  subtree (`proctree.mjs`) into one node list (cap 500, newest kept); `history: false` when the tracer
  is not installed. Debug: `node server.mjs --dump <session id>`.

Each live row in the sidebar Running view has a chevron that expands that tree inline: live processes with
their memory, finished ones dimmed with duration and exit code, collapsible per node (state remembered in
localStorage), refreshed every 2 s while open.

Rows in an **Other agent processes** group are `claude` / `claude-swap` processes of this user that
registered no status file (the VS Code extension, `--chrome-native-host`); they cannot be opened or
stopped, only expanded.

Stop (kill process) sends SIGTERM to a live session's pid after a second click; only pids from `~/.claude/sessions` whose start time still matches, owned by the same user.

**Leftover processes** (`leftovers.mjs`): CloudCLI runs each Claude CLI in its own scope `cloudcli-claude-<appSessionId>-<6 chars>.scope`. When that Claude exits, the scope keeps running while a child it started (a `setsid`/`nohup` job, a dev server, a tunnel) survives. `GET /leftovers` lists those scopes (not the unit of a live record in `~/.cloudcli/claude-processes/`, holding processes, the oldest at least 30 s old) as `{ serverStartedAt, groups }`, each group labelled from CloudCLI's session title and project and carrying its processes as a tree (`depth`, `command`, `rssBytes`). `POST /leftovers/kill` takes `{ unit, pid, procStart }` (one process and its descendants inside that unit) or `{ all: true }`. It re-checks at kill time that the unit is still a leftover and the pid still has that start time, refuses anything else with 409 (400 for a malformed body), never signals its own pid or its parent, sends SIGTERM and then SIGKILL after 5 s to what still runs. `serverStartedAt` is when this plugin server started, so a CloudCLI restart is visible to the UI. In the sidebar (`../ui-cleanup`), a "Leftover processes (N)" entry shows in the Running view while N > 0, and the list opens by itself once per restart until it is closed; each process has an X button.

A live process is always listed (even idle for days, or archived in CloudCLI). The "Ended · 24h" group is collapsed by default (remembered in localStorage).

Status changes become push notifications: every 3 s `events.mjs` compares each session's state with the
previous tick and records **needs input** (entering `waiting`), **failed** (back to idle with an API
error as the last reply) and **finished** (back to idle after a turn of 3 minutes or more). The first
tick after a start is silent. CloudCLI polls `GET /events?after=<seq>` and sends them through its own
notification settings, skipping chats it runs itself (it notifies those already).
`/events` also lists the sessions waiting right now (`waiting`): a "needs input" held back while a
CloudCLI tab was in use is re-sent once no tab is, if that session is still waiting.

Not covered: VS Code extension sessions don't write a status, so they only show via transcript activity. Codex/Cursor/OpenCode sessions aren't included.

Installed by `../ui-cleanup/inject.sh` at service start (CloudCLI ignores symlinked plugin dirs). Debug: `node server.mjs --dump`.
