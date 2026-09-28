#!/bin/bash
# LaunchAgent entry point for CloudCLI UI (this checkout) on macOS: localhost only, behind a tunnel.
# The macOS twin of ../systemd/claudecodeui.service; installed by `make service`.
# Secrets (e.g. CLAUDE_CODE_OAUTH_TOKEN) and ENV_SWITCHER live in ~/.cloudcli/service.env (chmod 600).
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# A stable keg path pinned to one Node major: node-pty is compiled for it, and a brew upgrade to
# a new major would otherwise break the Shell tab (and any path pointing into the Cellar).
NODE_BIN="${CLOUDCLI_NODE_BIN:-/opt/homebrew/opt/node@24/bin}"

# launchd starts with a bare environment: node, npm and the claude CLI must be findable for the
# Shell tab's pty and the provider install check.
export PATH="$NODE_BIN:/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export NODE_ENV=production
export SERVER_PORT=8022
export CLAUDE_CLI_PATH="$HOME/.local/bin/claude"
# Playwright (Browser feature) is installed outside the app tree so `npm ci` never touches it
export NODE_PATH="$HOME/.local/share/cloudcli-extra/node_modules"

set -a
if [ -f "$APP/.env" ]; then . "$APP/.env"; fi
if [ -f "$HOME/.cloudcli/service.env" ]; then . "$HOME/.cloudcli/service.env"; fi
set +a

# Tunnel-only: never listen beyond loopback, whatever the env files say.
export HOST=127.0.0.1
# Lets `make restart` tell it runs inside CloudCLI's own Shell tab (the pty inherits this env).
export CLOUDCLI_SERVICE=1

# Unset rather than export empty: an empty CLAUDE_CODE_OAUTH_TOKEN would still
# be picked up ahead of other credential sources by the Claude Agents SDK.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  unset CLAUDE_CODE_OAUTH_TOKEN
  echo "[cloudcli-service] CLAUDE_CODE_OAUTH_TOKEN: not set"
else
  echo "[cloudcli-service] CLAUDE_CODE_OAUTH_TOKEN: set"
fi

cd "$APP"
"$APP/custom/ui-cleanup/inject.sh" "$APP" || true
exec node dist-server/server/index.js
