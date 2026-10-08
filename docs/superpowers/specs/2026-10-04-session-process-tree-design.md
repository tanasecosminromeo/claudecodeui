# Session process tree (Session Radar) + agent exec tracer

Date: 2026-10-04. Status: draft, awaiting review.

## Goal

See everything agents actually do on this host: every `claude` and `claude-swap` process and every
process they start (Bash-tool commands, `curl`, `git`, MCP servers, nested `claude -p`, ...), as a
collapsible tree. Short-lived commands that finish in milliseconds must show up too, so the view cannot
rely on `/proc` snapshots alone.

## Decisions (from brainstorming)

- Capture: live tree from `/proc` **plus** an exec log written by a root bpftrace tracer.
- Scope: per OS user. A CloudCLI instance only shows the processes and exec history of the user it runs
  as. The tracer writes one file per uid, readable only by that uid.
- Placement: inside Session Radar (`custom/session-radar/`), as an expandable tree per session row on
  the Sessions tab. No new plugin, no core (upstream) code.

## Scope

In: tracer script + root wrapper + systemd system unit + `make exec-tracer`; Session Radar backend
endpoint and tree builder; Sessions-tab UI; "Other agent processes" group; unit tests; e2e scenario;
READMEs.

Out: killing individual child processes; the sidebar Running view (keeps its chips, no tree); macOS
(claude-m4 has no bpftrace: live tree only, history shown as unavailable); filtering or masking secrets
in argv (the file is 0600 per user and the page is behind Cloudflare Access + CloudCLI login).

User does by hand: `make exec-tracer` (needs sudo password).

## Part 1: exec tracer (`custom/exec-tracer/`)

### bpftrace program (`agent-exec.bt`)

- On `tracepoint:syscalls:sys_exit_execve` / `execveat` success (or `sched:sched_process_exec`), walk
  `curtask->real_parent` up to 20 levels. If an ancestor's `comm` is `claude` or `claude-swap`, the
  process is an agent process: remember its pid in a map and print an `exec` record. Processes with no
  such ancestor are never printed.
- The record carries: kernel time, pid, ppid, uid, `root` (pid of the nearest `claude`/`claude-swap`
  ancestor), `lparent` (nearest ancestor that is tracked or is the root; bridges forked-but-not-exec'd
  subshells so the tree does not break), and argv (joined, each arg capped at the bpftrace string limit,
  about 200 bytes).
- `claude` / `claude-swap` processes themselves are also printed when their own ancestor matches (nested
  `claude -p` inside a Bash command), so nesting is visible.
- On `sched:sched_process_exit` for a tracked thread-group leader: print an `exit` record with pid and
  exit code, then forget the pid.

### Root wrapper (`agent-exec-tracer.py`, system python3)

- Runs bpftrace, parses its output lines, adds a wall-clock `ts` (ms since epoch), writes one JSON
  object per line to `/var/log/agent-exec/<uid>.jsonl`.
- Each file is created mode 0600 and chowned to its uid. Directory `/var/log/agent-exec` is 0755 root.
- Rotation: when a file passes 10 MB it is renamed to `<uid>.jsonl.1` (replacing the old one) and a new
  file is started.
- If bpftrace dies, the wrapper exits non-zero and systemd restarts it (`Restart=always`, 5 s backoff).

Record shapes:

    {"ts":1759570000123,"ev":"exec","pid":123,"ppid":120,"lparent":118,"root":100,"uid":1000,"argv":"curl -s https://example.com"}
    {"ts":1759570000456,"ev":"exit","pid":123,"uid":1000,"code":0}

### Install

`make exec-tracer` copies the program and wrapper to `/usr/local/lib/agent-exec-tracer/`, the unit to
`/etc/systemd/system/agent-exec-tracer.service`, then `systemctl daemon-reload` and
`enable --now`. `make exec-tracer-uninstall` reverses it. The unit file is tracked in the repo.

## Part 2: Session Radar backend

New module `custom/session-radar/proctree.mjs`, pure functions plus thin I/O:

- `liveTree(rootPid)`: walks `/proc` children (reusing `detail.mjs` helpers): pid, ppid, argv, RSS,
  start time, state. Bash-tool wrapper shells are labelled with the real command (existing
  `shellCommand()`).
- `readExecLog(uid, sinceMs)`: reads `/var/log/agent-exec/<uid>.jsonl` (and `.1` when needed), only
  records with `ts >= sinceMs`. Missing file or unreadable dir => `null` (history unavailable).
- `buildTree(rootPid, rootStartMs, live, records, cap = 500)`: merges both into one tree.
  - A record belongs to the session if its `root` is the session pid, or its `root` is a pid already in
    the session's tree (nested claude), and `ts >= rootStartMs` (guards pid reuse).
  - Node parent = `lparent` (falls back to `ppid`, then the root).
  - Live processes win over log records for the same pid; finished ones carry `code` and `durationMs`.
  - Keeps the newest `cap` nodes; reports `truncated: n`.
- Tree root: the topmost `claude-swap` ancestor of the session pid if there is one, else the session pid.

`server.mjs`:

- `GET /tree?sid=<sessionId>` -> `{ root, nodes: [...], history: true|false, truncated }`. Built only on
  request, so the 5 s `/sessions` poll stays cheap.
- `/sessions` gains a group of **other agent processes**: live `claude`/`claude-swap` processes of this
  uid without a `~/.claude/sessions/<pid>.json` (VS Code extension stream-json, `--chrome-native-host`,
  claude-swap itself). They are addressed by `pid:<pid>` in `/tree?sid=`.
- Only processes owned by the server's uid are ever read or returned.

## Part 3: UI (`custom/session-radar/index.js`)

Decision 2026-10-04: ui-cleanup hides the Sessions workspace tab, so the only place session rows are
seen is the sidebar Running view (about 300 px wide). The tree therefore opens **inline in the sidebar**,
compact; no tab is un-hidden.

- Each live row (and each "other agent process" row) gets a chevron. Expanding it shows the tree inline
  under the row, with the whole list staying in place.
- One monospace line per node, indent 10 px per level: `command · RSS or duration · exit code`; the
  command is truncated to the row width. Hover shows pid, full argv, start time (local) and exit code.
  Finished nodes are dimmed; non-zero exit codes are highlighted.
- Every node with children can be collapsed. Default: live branches open, finished branches collapsed.
  Open trees and collapsed nodes are kept in localStorage per session.
- While a tree is open it refreshes every 2 s; the list keeps its 5 s poll. Refreshing does not reset
  scroll or collapse state, and a list redraw re-inserts the open trees.
- If `history` is false, a one-line note: "Command history needs the exec tracer (make exec-tracer)".

## Testing

- vitest unit tests with fixture data: record-to-session association, `lparent` bridging, nested claude,
  pid-reuse guard, live-vs-log merge, cap/truncation, claude-swap root, missing log.
- Tracer: with the unit running, `claude -p` asked to run `curl -s https://example.com` produces a curl
  `exec` and `exit` record in the user's log; a non-agent `curl` from a normal shell produces none.
- e2e (`make e2e`): new scenario expands a session row and asserts a command the agent ran appears as a
  node.
