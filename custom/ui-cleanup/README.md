# cloudcli-ui-cleanup

Personal tweaks for CloudCLI UI (`~/Work/claudecodeui`), applied without touching its source so upstream updates don't undo them.

- `cleanup.css`: system font, 15px base, square corners, hides Report issue / Discord / GitHub star / version line / footer Settings.
- `cleanup.js`: Settings button next to Refresh in the sidebar header; Running tab shows the session-radar list (`../session-radar`); header usage meter + popup from `../claude-usage`; while any session waits on you, the favicon pulses and a pulsing "Needs input" badge (top right) opens that conversation.
- `inject.sh`: copies both into `dist/ui-cleanup/` (content-hashed), adds one marked line before `</head>` in `dist/index.html`, and syncs every plugin under `custom/*/` (dirs with a manifest.json) into `~/.claude-code-ui/plugins/<name>`. Idempotent, always exits 0.

Wired in via `ExecStartPre=-…/inject.sh` in `~/.config/systemd/user/claudecodeui.service` (tracked in `../systemd/`, install with `make service`), so every restart re-applies it, including after `npm run build`.

Update CloudCLI (see the repo Makefile):

    make upgrade

Disable: remove the `ExecStartPre` line, `systemctl --user daemon-reload`, rebuild or restart.

If a tweak stops working after an update, check the selectors first: upstream hrefs (`/issues/new`, `discord.gg`, repo URL), lucide icon classes (`lucide-settings`, `lucide-refresh-cw`, `lucide-activity`), and the sidebar structure (header / flex-1 list / footer).
