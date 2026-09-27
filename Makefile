# Personal fork of CloudCLI UI (siteboon/claudecodeui).
#   upstream = GitHub original (fetch only)   origin = your fork (github.com/tanasecosminromeo/claudecodeui)
# Your own code lives in custom/ so upstream merges rarely conflict.
#
#   make status    what upstream has that you don't (and vice versa)
#   make upgrade   merge upstream, install, build, restart  (the usual one)
#   make rollback  undo the last upgrade (back to the pre-upgrade tag), rebuild, restart
#   make deploy    build + restart (after your own changes)

UPSTREAM_URL    ?= https://github.com/siteboon/claudecodeui.git
UPSTREAM_BRANCH ?= main
SERVICE         ?= claudecodeui
UNIT            := $(HOME)/.config/systemd/user/$(SERVICE).service

.DEFAULT_GOAL := help
.PHONY: help remotes fetch status clean-check update install browser build restart deploy upgrade rollback logs service push

help:
	@sed -n '1,8p' Makefile | sed 's/^# \{0,1\}//'

remotes:
	@git remote get-url upstream >/dev/null 2>&1 || git remote add upstream $(UPSTREAM_URL)
	@git remote set-url --push upstream DISABLED-push-to-origin
	@git remote get-url origin >/dev/null 2>&1 || echo "note: no 'origin' yet -> git remote add origin git@github.com:tanasecosminromeo/claudecodeui.git"

fetch: remotes
	git fetch upstream --prune --tags

status: fetch
	@echo "== upstream commits not merged yet =="
	@git log --oneline HEAD..upstream/$(UPSTREAM_BRANCH) | head -40
	@echo "== your commits (not upstream) =="
	@git log --oneline --no-merges upstream/$(UPSTREAM_BRANCH)..HEAD | head -40
	@echo "== working tree =="
	@git status --short

clean-check:
	@git diff --quiet && git diff --cached --quiet || { \
	  echo "Uncommitted changes - commit or stash them first:"; git status --short; exit 1; }

# Merge (not rebase): your history stays intact and pushes to your fork never need --force.
update: clean-check fetch
	git tag -f pre-upgrade
	@git merge --no-edit upstream/$(UPSTREAM_BRANCH) || { \
	  echo; echo "Merge conflict. Fix the files, 'git add' them, 'git commit', then 'make install build restart'."; \
	  echo "Or give up with: git merge --abort"; exit 1; }

# npm ci installs exactly the lockfile and never rewrites it. --include=dev because a shell
# opened from CloudCLI inherits NODE_ENV=production, which would skip the build tools.
install:
	npm ci --include=dev
	$(MAKE) browser

# CloudCLI's Browser feature needs Playwright + Chromium. It lives OUTSIDE the app tree
# (found via NODE_PATH in the service unit): installing it inside with npm would re-resolve
# the whole tree and silently upgrade other packages (that broke the Claude SDK once).
EXTRA_DIR       ?= $(HOME)/.local/share/cloudcli-extra
PLAYWRIGHT_VER  ?= 1.63.0

browser:
	@mkdir -p $(EXTRA_DIR); [ -f $(EXTRA_DIR)/package.json ] || echo '{"name":"cloudcli-extra","private":true}' > $(EXTRA_DIR)/package.json
	cd $(EXTRA_DIR) && npm install --no-audit --no-fund playwright@$(PLAYWRIGHT_VER)
	cd $(EXTRA_DIR) && npx --no-install playwright install chromium
	@NODE_PATH=$(EXTRA_DIR)/node_modules node -e "const e=require('playwright').chromium.executablePath(); if(!require('fs').existsSync(e)){console.error('chromium missing: '+e);process.exit(1)} console.log('chromium: '+e)"

build:
	npm run build

# Run from CloudCLI's own Shell tab, a restart kills that terminal (it lives in the
# service's cgroup). Then hand the restart to systemd and exit before it lands.
restart:
	@if grep -q '/$(SERVICE).service' /proc/self/cgroup; then \
	  echo "Running inside CloudCLI's Shell: this terminal will close in ~2s. Reload the page after."; \
	  systemd-run --user --quiet --collect --on-active=2 systemctl --user restart $(SERVICE); \
	else \
	  systemctl --user restart $(SERVICE); sleep 4; systemctl --user is-active $(SERVICE); \
	  journalctl --user -u $(SERVICE) --since '-15s' -o cat | grep -E 'ui-cleanup|session-radar' || true; \
	fi

deploy: build restart

upgrade: update install build restart
	@echo "Upgraded. Undo with: make rollback"

rollback:
	@git rev-parse -q --verify pre-upgrade >/dev/null || { echo "no pre-upgrade tag"; exit 1; }
	@git diff --quiet && git diff --cached --quiet || { echo "Uncommitted changes - commit or stash first"; exit 1; }
	git reset --hard pre-upgrade
	$(MAKE) install build restart

logs:
	journalctl --user -u $(SERVICE) -f -o cat

# (Re)install the systemd unit tracked in custom/systemd/.
service:
	install -m 644 custom/systemd/$(SERVICE).service $(UNIT)
	systemctl --user daemon-reload
	systemctl --user enable $(SERVICE)

push:
	git push origin HEAD
