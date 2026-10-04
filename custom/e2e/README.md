# End-to-end tests (`custom/e2e/`)

Real CloudCLI, real Claude CLI, real browser. Each run builds this checkout
(uncommitted changes included) into a separate worktree, starts it as its own
systemd user service on port 3101 with its own database, and drives it with
Playwright/Chromium the way a person would. A "restart" in a scenario is a
real `systemctl --user restart`, exactly what `make restart` does to the live
service.

**The live service (port 3001, `~/.cloudcli/auth.db`, this checkout's `dist/`)
is never touched.**

```sh
make e2e                                   # build + every scenario (~6 min)
make e2e E2E_ARGS="--only=restart"         # scenarios whose file name contains "restart"
make e2e E2E_ARGS="--only=03,07 --keep"    # several, keep the run folder afterwards
make e2e E2E_ARGS="--skip-build"           # reuse the last build (scenario-only changes)
make e2e E2E_ARGS="--list"                 # list scenarios
node custom/e2e/run.mjs --app-dir=DIR      # test an already-built app folder as is
node custom/e2e/run.mjs --headed           # watch the browser
```

Every run writes a self-contained HTML report — steps, timing, screenshots,
and with `--with-unit` the unit tests behind the same guarantees — to
`custom/e2e/reports/latest.html` and to `public/e2e-reports/latest.html`, which
the live CloudCLI serves: open `<app url>/e2e-reports/latest.html` (both
folders are git-ignored; a dated copy sits next to `latest.html`).

Exit code 0 when everything passed. Cost: a few cents per full run (the
scenarios use Haiku); time: about 6 minutes plus the build.

## What each scenario proves

| File | Guarantee |
|---|---|
| `01-send-and-reply` | Smoke: a new chat sends and gets a reply. If this fails, suspect setup, not a feature. |
| `02-mid-turn-send` | A message sent while Claude works joins the running turn (answer covers both), no "Send anyway?" dialog, never a second Claude process. |
| `03-restart-survival` | Restart mid-turn: the same Claude process survives in its own scope, the browser reconnects by itself and shows the rest of the turn, the next message goes to the same process, background work started before the restart reports back, and the process exits once it has nothing left to do. |
| `04-plan-build-keeps-mode` | Auto → plan → **Build** continues in auto: no approval prompts after Build, and the mode selector shows auto again. (The original bug: Build dropped the CLI to `default`.) |
| `05-mode-switch-mid-run` | Picking a mode while Claude waits on an approval applies to the running turn: the next edit does not ask again. |
| `06-btw-side-question` | `/btw` while Claude works: the answer opens in a popup, the turn keeps running (also when the popup is closed with Escape), and the side question never enters the conversation. |
| `07-terminal-takeover` | A session open in a real terminal (`claude --resume` in a pseudo-terminal): sending from the web asks to take over; accepting stops the terminal's process and the message runs in the web. |
| `08-approval-across-restart` | Restart while an approval prompt is open: the lost prompt's step is stopped, the chat says so (even though no browser was connected when that happened), the command did not run, and the session is usable right after. |
| `09-stop-keeps-background` | Stop ends the turn but not background work: same process afterwards, the next message goes to it, the background command still reports. |
| `10-two-tabs-one-process` | The session open in two tabs: both stream; a send from the second tab mid-turn joins the one process. |
| `11-reload-mid-turn` | F5 mid-turn: the reloaded page shows the turn still running and its end. |
| `12-shell-tab-guard` | Shell tab on a session the chat holds: the terminal says "already running in the CloudCLI chat", asks, and "n" leaves a plain shell with still one Claude process. |
| `13-scheduled-message-joins-turn` | A scheduled message due mid-turn (via the API) joins the running turn: no abort, same process answers both. |
| `14-edit-replaces-process` | Editing a sent message while the process is held for background work replaces the process, and on disk the edited prompt branches off the reply before it (the replaced turn is no longer an ancestor). Two upstream gaps it steers around: editing the very first prompt starts a new CLI session file the app does not follow, and the rendered chat still shows the abandoned branch after a reload (the reader only hides it when both prompts share a parent row). |
| `15-btw-idle-fork` | `/btw` on an idle session: a throwaway fork answers from the conversation, writes no transcript, leaves no process. |
| `16-restart-idle-with-background` | Restart while idle but holding a process for background work: same process, session not shown busy, work still tracked, and it outlives the (test-shortened, 20s) ceiling for *untracked* work — the distinction that a real crash watch died of. |
| `17-crash-survival` | The server SIGKILLed mid-turn (no shutdown handler runs): the process survives, the turn finishes, the session works. |
| `18-bypass-picked-mid-run` | Bypass picked while a process launched in default runs: the CLI cannot switch, the app approves for the user, the next edit does not ask. |
| `19-quick-archive-undo` | One click on the sidebar row's archive icon (and on the header's, for the open session) archives on the server, closes the session, drops its row and shows an "Archived …" notice; Undo restores through the server, puts the row back and reopens the session. |
| `20-last-message-stamp` | The last reply's copy/speak row ends, right-aligned and italic, with "last message YYYY-MM-DD HH:mm:ss · Xd Xh Xm Xs ago", and the "ago" holds still (it is measured again only when the last message changes or the page reloads). Hidden while a turn runs. |
| `21-read-aloud-romanian` | The speaker button on a Romanian reply plays it (the button turns into Stop), and the MP3 `/api/voice/tts` returns, run back through Parakeet, comes out as the same Romanian words: the local Piper backend picked the Romanian voice by itself. Needs `VOICE_API_BASE_URL` in this checkout's `.env` (the run passes it to the instance) and the llama.cpp `tts` + `stt` services up. |
| `22-speak-summary` | Hovering the speaker on a long reply shows a "Summarised" menu item; clicking it opens a popover with the summary the speech backend reads long replies as (Gemma, via llama.cpp's `tts` service), shorter than the reply, with its own read-aloud button and a Close button. Needs the llama.cpp `tts`, `stt` and `llama-cpp` services. |
| `23-hidden-plugin-tabs` | The Usage and Sessions plugin tabs are gone from the workspace tab bar (ui-cleanup; they live in the header meter and the sidebar Running view), arrow keys in the tab bar skip them, and both plugins stay enabled. The run applies `custom/ui-cleanup/inject-html.mjs` to the build, as the live service does on start. |
| `27-artefacts-share` | `share publish` (custom/share) of a report folder shows up in the sidebar: the Conversations tab reads "Artefacts" and lists the share (tagged separate, with its expiry) under its session; the sidebar search box says "Search artefacts..." and filters the list; the share service serves the report and its relative screenshot with no login, a wrong token is a 404; Open session goes to the session, and leaving the tab gives the normal list and search back. Uses a 90-minute separate share in the real `~/shares`, purged at the end; needs `make share-install`. |
| `28-process-tree` | A live row in the sidebar Running view has a chevron; expanding it shows the session's process tree, with the `sleep` the agent is running as a live node under the claude process. With `make exec-tracer` installed the node stays after the command ends, dimmed, with its duration; without it the tree says "Command history needs the exec tracer". Needs the installed plugin copy refreshed first (`make restart`, or `custom/ui-cleanup/inject.sh` alone): the instance uses `~/.claude-code-ui/plugins`. |

### Bugs these scenarios found (all fixed)

- Escape to close the `/btw` popup (or any menu/dialog) also stopped Claude's
  turn: the global Esc-to-Stop listener runs in the capture phase, ahead of
  the popup. (`06`)
- After a restart, a note the server raised before the browser reconnected
  was lost: the browser reloads Claude's transcript (which does not contain
  app-raised notes) and asked for events after a sequence number from the
  previous server. Now unseen errors are kept for the first subscriber, and a
  stale sequence number replays the run from its start. (`08`)
- The duplicate-session guard was skipped right after CloudCLI let its own
  process go (the process was still registered while winding down), so the
  next message started a second process next to a terminal. (`07`)
- A restart with a Shell tab open took 90 seconds: the interactive shell in
  the service's cgroup ignores SIGTERM and systemd waits its full stop timeout.
  The server now ends its terminals on shutdown. (found by `12` slowing `16`)

Found by review of the same code, pinned by unit tests: a message sent right
after Stop could be ended by the stopped turn's late `result`; a message
pushed just as the CLI wrote its `result` was taken as a new turn and then
cut off; a released process at restart time was reattached (and its sibling
orphaned) instead of being stopped; a launch into a deleted project folder
crashed the whole server.

## How it is put together

```
custom/e2e/
  run.mjs              runner: build, start instance, run scenarios, artifacts, summary
  lib/workspace.mjs    mirrors this checkout (HEAD + staged + unstaged + untracked) into
                       ../claudecodeui-worktrees/e2e, npm ci when the lockfile changed, build
  lib/instance.mjs     the isolated instance: transient unit `cloudcli-e2e`, start/restart/stop,
                       first user + project via the API, detached-process records, cleanup
  lib/chat.mjs         ChatPage: the chat as a person uses it (send, wait, modes, approvals)
  scenarios/NN-*.mjs   one scenario per file: `meta` + `run(tools)`
```

Isolation of the instance (`lib/instance.mjs`):

- port `E2E_PORT` (3101), loopback only; unit `E2E_UNIT` (`cloudcli-e2e`)
- run folder `E2E_RUN_DIR` (default `~/.cache/cloudcli-e2e`, **not** `/tmp`: the app
  refuses to create projects in system directories): database, project folder
  `project/`, detached Claude processes `claude-processes/`, `artifacts/`
- `CLOUDCLI_DETACHED_CLAUDE=1` (restart survival) — `E2E_DETACHED=0` to test without
- shared on purpose: `~/.claude` (real login and settings — the scenarios run the
  real CLI). Shared because they cannot be split without faking HOME: the
  plugins in `~/.claude-code-ui` (the instance starts its own copies of the
  enabled plugin servers on random ports) and the read-only index of
  `~/.claude/projects` (the sidebar lists your real projects; scenarios only
  open `e2e-project`)
- the first-run wizard is skipped through the API (its git step would run
  `git config --global`)
- `07` answers Claude Code's "do you trust this folder?" for the test project
  once; Claude Code remembers that in `~/.claude.json`
- `CLOUDCLI_BG_WAIT_CEILING_MS=20000` (30 min in production): the hold for
  background work the runtime cannot track. Every backgrounded command the
  scenarios start is tracked and must outlive it (`16`).
- the unit gets `TimeoutStopSec=15`, so a child that ignores SIGTERM can never
  stall a scenario for systemd's default 90s

Cleanup after a run: the unit is stopped, its detached Claude processes are
killed, the test project's transcripts in `~/.claude/projects` are removed, and
the run folder is deleted — **unless a scenario failed or `--keep` was given**:
then the run folder stays for its artifacts, with the sessions' transcripts
copied to `artifacts/transcripts/`.

## When a scenario fails

The summary prints the artifacts folder, `~/.cache/cloudcli-e2e/artifacts/<scenario>/`:

- `failure.png` — full-page screenshot at the moment of failure
- `failure.transcript.txt` — the chat as rendered (user and Claude messages)
- `server.log` — the last 600 lines of the instance's journal
- `details.json` — the error with stack, browser dialogs seen, console errors,
  live detached Claude processes (pid, session, turn/task state), URL

`artifacts/report.json` has the whole run. `07` also leaves
`artifacts/07-terminal-screen.log`: what the terminal `claude` printed.

Look at the transcript before blaming the feature: Claude sometimes declines
an instruction (the CLI refuses a foreground command that *starts* with a long
`sleep` — use `python3 -c "import time; time.sleep(N)"` for foreground waits;
background `sleep` is fine).

## Writing a scenario

```js
// custom/e2e/scenarios/10-something.mjs
export const meta = {
  title: 'One line: the guarantee this checks',
  timeoutMs: 180000,          // whole scenario
  mode: 'bypassPermissions',  // starting permission mode (default|auto|acceptEdits|bypassPermissions|plan)
  model: 'haiku',             // starting model
  allowDialogs: false,        // true when the scenario expects window.confirm/alert
};

export async function run({ chat, page, app, paths, log, expect, sleep, restart, processes, projectFile }) {
  await chat.openNewChat();
  await chat.send('…');
  const sessionId = await chat.sessionId();
  await chat.waitForAssistant(/WORD/, 60000);
  expect(processes(sessionId).length === 1, 'one Claude process');   // logs ✓ or fails the scenario
}
```

Tools a scenario gets:

- `chat` (`lib/chat.mjs`): `openNewChat()`, `send(text)` (Send button, or Enter
  while a turn runs), `sessionId()`, `isWorking()` / `waitWorking()` /
  `waitIdle()` / `stopTurn()` (the composer's own Stop), `assistantText()`,
  `waitForAssistant(regex)`, `assistantMessageCount()` +
  `waitForNewAssistant(regex, afterCount)`, `transcriptText()`,
  `setMode(mode)` / `currentMode()`, `hasApprovalPrompt()` /
  `waitForApprovalPrompt()` / `allowOnce()`, `dialogs` + `onDialog`
- `restart()` — `systemctl --user restart cloudcli-e2e`, resolves once it answers
- `crash()` — SIGKILLs the instance (no shutdown handlers run) and starts it again
- `processes(sessionId?)` — live detached Claude processes of the instance, from
  their records: `{ pid, appSessionId, providerSessionId, turnActive,
  awaitingPermission, tasks }`
- `projectFile(name)` — path inside the test project (check what Claude wrote)
- `page` (Playwright), `app` (`{ base, token, project }`), `paths`, `log`, `sleep`

Rules that keep scenarios reliable:

- Check Claude's replies with `waitForAssistant` / `waitForNewAssistant`, never the
  whole page: your own message contains the words you look for, and tool
  blocks show the commands Claude ran (`echo BGDONE` is on screen long before
  the command reports).
- "Is Claude working" is the **composer's** Stop (`form button[aria-label=Stop]`).
  The background-task strip has its own Stop per task — clicking that stops
  the task.
- Do not press Escape to close the mode menu: while a turn runs, Escape outside
  a popup is the Stop shortcut. `setMode`/`currentMode` close the menu by
  clicking.
- Ask for exact words (`reply with the single word PONG`) and use Haiku; keep
  waits generous — model latency varies (a first tool call has taken 25s).
- A terminal `claude` started from a process that itself runs under Claude
  Code inherits `CLAUDE_CODE_*` markers and becomes a child session that does
  not register; strip them (see `07`).
- Leave a Shell-tab terminal with `exit` (see `12`): the harness's stop
  timeout is short, but a stuck shell still costs 15s per restart.
- Read Claude's *new* messages with `waitForNewAssistant(regex, countBefore)`
  when the word could already be on screen (a command's `echo BGDONE`).
- The Shell tab's terminal text is not in the DOM (canvas renderer); read it
  from the shell websocket frames instead (`12`).

## Selectors

Role- and label-based, from the app's own accessibility names:

| What | Selector |
|---|---|
| composer | placeholder `Type / for commands, @ for files, or ask Claude anything...` |
| send | button `Send` (exact) |
| turn stop | `form button[aria-label="Stop"]` |
| mode menu | button `How should Claude actions be approved?` → `menuitemradio` `Default Mode` / `Auto Mode` / `Accept Edits` / `Bypass Permissions` / `Plan Mode` (`aria-checked`) |
| approval | buttons `Allow once`, `Allow & remember`, `Deny` |
| plan approval | button `Build` (and `Revise`) |
| `/btw` answer | `[role=dialog]` |
| edit a sent message | hover the `.chat-message`, button `Edit and resend`; then the composer holds the text |
| tabs | `getByRole('tab', { name: 'Shell' })`, `'Chat'` |
| shell output | Playwright `page.on('websocket')` for the `/shell` socket: frames `{ type: 'output', data }` |
| messages | `.chat-message.assistant`, `.chat-message` (structural — the one class-based selector) |
| project | sidebar button whose name starts with `e2e-project`, then `New Session` |

The session id is in the URL after the first send: `/session/<app session id>`.
The provider (transcript) id is the newest `*.jsonl` in
`~/.claude/projects/<project path with non-alphanumerics as ->/`.
