# claude-usage (CloudCLI plugin)

Claude plan limits for every account managed by `claude-swap` (`~/.local/bin/claude-swap`):
5-hour, 7-day and per-model weekly windows, reset countdowns, and whether the week will last.

- **Header meter** (added by `../ui-cleanup/cleanup.js`): `5h N% · 7d N%` for the active account,
  green / amber (>=70%) / red (>=90%, or any per-model limit); `!` = a per-model limit is at 100%.
  Click for the full popup.
- **"Usage" workspace tab**: the same cards.

Backend runs `claude-swap list --json`, keeps only whitelisted fields (account number, email,
organization, active flag, usage windows) and caches for 60s (Refresh forces, at most every 10s).
No credentials are read or returned.

**Switch**: inactive accounts get a Switch button (click twice to confirm). It runs
`claude-swap switch <n>` (POST /switch, number validated against the list), which swaps the machine's
Claude login, so new Claude sessions, in CloudCLI and in terminals alike, use that account; running
sessions keep theirs. A `CLAUDE_CODE_OAUTH_TOKEN` pinned in the service's env overrides it, so don't
pin one on machines where you want to switch from the web.

**Codex** (`codex.mjs`): on machines that use the Codex CLI, a Codex card shows its plan's 5-hour and
weekly windows (plus any other limit, e.g. premium credits) and the meter's tooltip gets a Codex line.
Read from the newest `rate_limits` snapshot in `$CODEX_HOME/sessions/**/rollout-*.jsonl` (Codex writes
one per request), so the numbers are as of the last Codex request on this machine; a window whose reset
has passed since then shows as reset. No `~/.codex/sessions`, or nothing newer than two weeks: no card.

Installed by `../ui-cleanup/inject.sh` at service start (starts on first request, no restart needed
after a first install). Debug: `node server.mjs --dump`.
