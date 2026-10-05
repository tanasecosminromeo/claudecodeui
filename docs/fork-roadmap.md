# Fork roadmap

Work planned for this fork's own features (see "What's different in this fork" in the [README](../README.md)).
Ordered by priority. Each item says what "done" means; an item is done when `make e2e` covers it, not
when it works once by hand. When an item ships, update its row in the README.

## 1. Check and fix

### 1.1 One live Claude process per session
Status 🧪. It's not clear this holds up in daily use, even though e2e scenarios 01–18 pass.
- Collect the cases where it went wrong: two processes on one session, a reply missing after a
  restart, a terminal and the web UI splitting a conversation.
- Write an e2e scenario that reproduces each case, then fix it.
- **Done:** every collected case is an e2e scenario and passes, and there have been no new reports for a week of daily use.

### 1.2 Keeping machines in step (`make sync`, `make remote`)
Status 🧪. Syncing between machines doesn't work reliably.
- Reproduce on each machine and write down the exact failure. Likely causes to check first:
  - `make remote` runs `ssh host 'make …'` in a non-login shell, so Homebrew's `node`/`npm` may be
    missing from `PATH` on macOS.
  - `make sync` uses `git merge --ff-only`, which refuses as soon as a machine has a local commit.
  - `clean-check` stops on any uncommitted file.
- **Done:** `make upgrade && make push` on one machine, then `make remote HOST=<other> TARGET=sync`,
  leaves both machines on the same commit, built, restarted, with `make verify` passing.

### 1.3 Plan approval and background agents
Status ✅ for the main session. Background agents don't follow the mode picked when you approve a plan.
- Reproduce: plan mode → approve with "accept edits" → Claude starts a background agent that
  edits files → see whether the agent asks for each edit.
- Things to check:
  - Approving applies the mode with `setMode` (destination `session`) on the main process. Agents
    already running, or started in the background, may not pick it up.
  - Claude Code may handle permissions differently for background agents: they can't stop to ask,
    so anything not approved beforehand may be denied.
- If the CLI doesn't let us change this, say so in the README row and close the item.
- **Done:** an e2e scenario where a background agent edits a file after "accept edits" without asking,
  or a documented CLI limitation.

## 2. UX fixes

### 2.1 Quick archive visible without hovering
Today the archive button only appears on hover, where it replaces the row's age.
- Show both the age and the archive button, including on touch screens, which have no hover.
- **Done:** e2e scenario 19 archives without hovering first.

### 2.2 Stars like Gmail
- A quick click cycles the colour. Clicking again after a few seconds removes the star instead.
- Starring or recolouring doesn't move the project; add a "Starred" filter to the sidebar instead.
- **Done:** e2e scenario 26 covers cycling, unstarring after the delay, the project staying in place, and the filter.

### 2.3 "Needs input" for every session, kept until handled
Today the pulsing favicon and badge point at one waiting session and disappear when it changes.
- Mark every waiting session on its own row, and show a count on its project, so opening a project
  shows what you need to unblock.
- Keep the marker until you answer, including across reloads and restarts.
- **Done:** an e2e scenario with two sessions waiting in two projects shows both markers, before and after a reload.

## 3. Extend

### 3.1 `/btw` history
Status 🚧. Answers only appear in a modal and are lost when you close it.
- Save each question and answer with its session, and add a way to open past ones.
- They still must not go into the transcript or the model's context.
- **Done:** an e2e scenario asks two `/btw` questions, reloads, and opens both from the history.

### 3.2 Finish what's in progress
Each moves to ✅ once its open issues are listed, fixed and covered by e2e:
- Running view and per-session process tree (session-radar, exec-tracer)
- Account auto-switch (claude-usage)
- Public share links and the Artefacts tab (share)
- Star colours and project groups (also 2.2)

### 3.3 Publish the speech service
"Summarised" read-aloud depends on a speech service with an `/audio/speech/summary` endpoint that
isn't public yet. Publish it (without infra details), link it from the README row, and document setup.

### 3.4 MVP → ✅
Add tests and a short README to each of these: Codex usage, env-switcher, claude-guard, macOS LaunchAgent, commit-guard.
