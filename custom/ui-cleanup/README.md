# cloudcli-ui-cleanup

Personal tweaks for CloudCLI UI (`~/Work/claudecodeui`), applied without touching its source so upstream updates don't undo them.

- `cleanup.css`: system font, 15px base, square corners, hides Report issue / Discord / GitHub star / version line / footer Settings.
- `cleanup.js`: Settings button next to Refresh in the sidebar header; Running tab shows the session-radar list (`../session-radar`); header usage meter + popup from `../claude-usage`; while any session waits on you, the favicon pulses and a pulsing "Needs input" badge (top right) opens that conversation.
- `inject.sh`: runs `inject-html.mjs`, then syncs every plugin under `custom/*/` (dirs with a manifest.json) into `~/.claude-code-ui/plugins/<name>`. Idempotent, always exits 0.
- `inject-html.mjs`: copies both (and `../env-switcher/` when `ENV_SWITCHER` is set) into `dist/ui-cleanup/` (content-hashed) and puts one marked block before `</head>` in `dist/index.html`. Plain Node, so it behaves the same with macOS's BSD tools and on Linux.

Wired in so every restart re-applies it, including after `npm run build`:
- Linux: `ExecStartPre=-…/inject.sh` in `~/.config/systemd/user/claudecodeui.service` (tracked in `../systemd/`).
- macOS: `../launchd/cloudcli-service.sh` runs it before starting the server (LaunchAgent `ai.cloudcli.server`).

Install either with `make service`. Tests: `make test-custom`.

Update CloudCLI (see the repo Makefile):

    make upgrade

Disable: Linux, remove the `ExecStartPre` line, `systemctl --user daemon-reload`; macOS, remove the `inject.sh` line from `../launchd/cloudcli-service.sh`. Then rebuild or restart.

If a tweak stops working after an update, check the selectors first: upstream hrefs (`/issues/new`, `discord.gg`, repo URL), lucide icon classes (`lucide-settings`, `lucide-refresh-cw`, `lucide-activity`), and the sidebar structure (header / flex-1 list / footer).
