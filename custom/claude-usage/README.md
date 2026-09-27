# claude-usage (CloudCLI plugin)

Claude plan limits for every account managed by `claude-swap` (`~/.local/bin/claude-swap`):
5-hour, 7-day and per-model weekly windows, reset countdowns, and whether the week will last.

- **Header meter** (added by `../ui-cleanup/cleanup.js`): `5h N% · 7d N%` for the active account,
  green / amber (>=70%) / red (>=90%, or any per-model limit); `!` = a per-model limit is at 100%.
  Click for the full popup.
- **"Usage" workspace tab**: the same cards.

Backend runs `claude-swap list --json`, keeps only whitelisted fields (account number, email,
organization, active flag, usage windows) and caches for 60s (Refresh forces, at most every 10s).
No credentials are read or returned. Read-only: there is deliberately no switch button.

Installed by `../ui-cleanup/inject.sh` at service start (starts on first request, no restart needed
after a first install). Debug: `node server.mjs --dump`.
