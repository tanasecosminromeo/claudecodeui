# Personal fork of CloudCLI UI (siteboon/claudecodeui).
#   upstream = GitHub original (fetch only)   origin = your fork on GitHub
# Your own code lives in custom/ so upstream merges rarely conflict.
#
#   make status    this machine vs origin, vs the latest stable upstream release, plugin clones
#   make upgrade   merge the latest stable upstream release, then install, build, plugins, test, restart, verify
#                  (REF=upstream/main for the unreleased tip; rerunning is a no-op when already merged)
#                  then: make push, and on the other machine: make sync  (or: make remote HOST=dev TARGET=sync)
#   make sync      fast-forward this machine to origin/main, then install, build, plugins, test, restart, verify
#   make rollback  undo the last upgrade/sync (back to the pre-upgrade tag), rebuild, restart
#   make deploy    build + restart (after your own changes)
#   make remote    run a target on another machine over ssh: make remote HOST=dev TARGET=status
#   make claude-guard  make terminal `claude --resume` ask before opening a session already running elsewhere
#   make e2e       end-to-end tests: an isolated copy of this checkout, real Claude CLI, real browser
#                  (E2E_ARGS="--only=restart --keep"; see custom/e2e/README.md)
#
# Claude sessions survive `make restart`: with CLOUDCLI_DETACHED_CLAUDE=1 (set in the systemd unit) each
# Claude process runs in its own scope and the restarted server reattaches to it.

UPSTREAM_URL    ?= https://github.com/siteboon/claudecodeui.git
UPSTREAM_BRANCH ?= main
FORK_BRANCH     ?= main
SERVICE         ?= claudecodeui
UNIT            := $(HOME)/.config/systemd/user/$(SERVICE).service
# macOS runs the same app as a LaunchAgent instead of a systemd user unit (custom/launchd/).
UNAME           := $(shell uname -s)
LABEL           ?= ai.cloudcli.server
PLIST           := $(HOME)/Library/LaunchAgents/$(LABEL).plist
LAUNCHD         := gui/$(shell id -u)
LOG_DIR         := $(HOME)/Library/Logs/cloudcli
PLUGINS_DIR     ?= $(HOME)/.claude-code-ui/plugins
# Port the service listens on: .env, else the platform default (custom/launchd sets 8022, systemd 3001).
PORT            ?= $(or $(shell sed -n 's/^SERVER_PORT=//p' .env 2>/dev/null),$(if $(filter Darwin,$(UNAME)),8022,3001))
# Public URL behind the tunnel, checked by `make verify` when set (PUBLIC_URL= in .env, or on the command line).
PUBLIC_URL      ?= $(shell sed -n 's/^PUBLIC_URL=//p' .env 2>/dev/null)
# Where the checkout lives on other machines, relative to their $HOME (for `make remote`).
REMOTE_DIR      ?= Work/claudecodeui

# Latest stable upstream release: the highest vX.Y.Z tag on upstream/main (the cloudcli-local-server-*
# tags are pre-releases). Recursively expanded on purpose, so it is read after `fetch` has run.
LATEST_TAG      = $(shell git tag --merged upstream/$(UPSTREAM_BRANCH) --sort=-v:refname 'v[0-9]*' 2>/dev/null | head -1)
# What `make upgrade` merges. REF=upstream/main for the unreleased tip.
REF             ?= $(LATEST_TAG)

# Over a non-interactive ssh (make remote) nvm is not loaded, so fall back to its newest node.
ifeq ($(shell command -v node 2>/dev/null),)
NVM_NODE        := $(shell ls -d $(HOME)/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)
ifneq ($(NVM_NODE),)
export PATH     := $(NVM_NODE):$(PATH)
endif
endif

.DEFAULT_GOAL := help
.PHONY: help remotes fetch status clean-check update sync install browser build restart deploy upgrade rollback \
        logs service push test-custom plugins plugins-status verify remote claude-guard e2e

help:
	@sed -n '/^$$/q;p' Makefile | sed 's/^# \{0,1\}//'

remotes:
	@git remote get-url upstream >/dev/null 2>&1 || git remote add upstream $(UPSTREAM_URL)
	@git remote set-url --push upstream DISABLED-push-to-origin
	@git remote get-url origin >/dev/null 2>&1 || echo "note: no 'origin' yet -> git remote add origin git@github.com:<you>/claudecodeui.git"

fetch: remotes
	git fetch upstream --prune --tags
	git fetch origin --prune

status: fetch
	@echo "== this machine: $$(git describe --tags --always) on $$(git branch --show-current) =="
	@echo "== latest stable upstream release: $(LATEST_TAG) ($$(git merge-base --is-ancestor $(LATEST_TAG) HEAD && echo merged || echo 'NOT merged -> make upgrade')) =="
	@echo "== on origin/$(FORK_BRANCH) but not here (make sync) =="
	@git log --oneline HEAD..origin/$(FORK_BRANCH) | head -40
	@echo "== here but not on origin/$(FORK_BRANCH) (make push) =="
	@git log --oneline origin/$(FORK_BRANCH)..HEAD | head -40
	@echo "== upstream/$(UPSTREAM_BRANCH) commits not merged yet (make upgrade REF=upstream/$(UPSTREAM_BRANCH)) =="
	@git log --oneline HEAD..upstream/$(UPSTREAM_BRANCH) | head -40
	@echo "== your commits (not upstream) =="
	@git log --oneline --no-merges upstream/$(UPSTREAM_BRANCH)..HEAD | head -40
	@echo "== working tree =="
	@git status --short
	@$(MAKE) --no-print-directory plugins-status

clean-check:
	@git diff --quiet && git diff --cached --quiet || { \
	  echo "Uncommitted changes - commit or stash them first:"; git status --short; exit 1; }

# Merge (not rebase): your history stays intact and pushes to your fork never need --force.
# Refuses to run while origin is ahead (both machines must start from the same commit), and is
# a no-op when HEAD already contains REF, so rerunning `make upgrade` is safe.
update: clean-check fetch
	@[ -n "$(REF)" ] || { echo "no upstream release tag found (REF is empty)"; exit 1; }
	@[ -z "$$(git log --oneline HEAD..origin/$(FORK_BRANCH))" ] || { \
	  echo "origin/$(FORK_BRANCH) is ahead of this machine: run 'make sync' first"; exit 1; }
	git tag -f pre-upgrade
	@if git merge-base --is-ancestor $(REF) HEAD; then echo "already contains $(REF): nothing to merge"; exit 0; fi; \
	 git merge --no-edit $(REF) || { \
	  echo; echo "Merge conflict. Fix the files, 'git add' them, 'git commit', then 'make install build restart'."; \
	  echo "Or give up with: git merge --abort"; exit 1; }

# The second machine, after `make upgrade && make push` on the first. Fast-forward only, so a
# local-only commit stops it instead of being merged.
sync: clean-check fetch
	git tag -f pre-upgrade
	git merge --ff-only origin/$(FORK_BRANCH)
	$(MAKE) install build plugins test-custom restart verify
	@echo "Synced to $$(git describe --tags --always). Undo with: make rollback"

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

# Plugins under $(PLUGINS_DIR) that are git clones. The custom/ ones are copies made by inject.sh on
# every start and follow this repo, so they never show up here.
plugins-status:
	@echo "== plugin clones in $(PLUGINS_DIR) =="
	@for d in $(PLUGINS_DIR)/*/; do [ -d "$$d/.git" ] || continue; \
	  ( cd "$$d" && git fetch -q 2>/dev/null; \
	    printf '%-34s %s' "$$(basename "$$d")" "$$(git rev-parse --short HEAD)"; \
	    printf '  behind %s  ahead %s' "$$(git rev-list --count HEAD..@{u} 2>/dev/null || echo '?')" \
	                                   "$$(git rev-list --count @{u}..HEAD 2>/dev/null || echo '?')"; \
	    [ -z "$$(git status --short)" ] || printf '  DIRTY'; echo ); \
	done

# Fast-forward every plugin clone; a clone with local changes or commits fails here on purpose.
# Dependencies are reinstalled only when the pull moved HEAD, with --ignore-scripts like the
# original install (see custom/launchd/cloudcli-service.sh).
plugins:
	@for d in $(PLUGINS_DIR)/*/; do [ -d "$$d/.git" ] || continue; \
	  echo "== $$(basename "$$d")"; \
	  ( cd "$$d" && before=$$(git rev-parse HEAD) && git pull --ff-only && \
	    if [ "$$before" != "$$(git rev-parse HEAD)" ] && [ -f package.json ]; then \
	      npm install --ignore-scripts --no-audit --no-fund; fi ) || exit 1; \
	done

ifeq ($(UNAME),Darwin)
LISTENERS = lsof -nP -iTCP:$(PORT) -sTCP:LISTEN | awk 'NR>1{print $$9}'
else
LISTENERS = ss -tlnH "sport = :$(PORT)" | awk '{print $$4}'
endif

# The service must answer, listen on loopback only (it sits behind a tunnel), and the public URL
# (when known) must reach it. Waits for a restart that is still landing.
verify:
	@for i in $$(seq 1 15); do curl -sf -o /dev/null http://127.0.0.1:$(PORT)/ && break; \
	  [ $$i -lt 15 ] || { echo "verify: nothing answers on 127.0.0.1:$(PORT)"; exit 1; }; sleep 2; done
	@echo "verify: http://127.0.0.1:$(PORT)/ answers"
	@listeners=$$($(LISTENERS)); echo "$$listeners" | sed 's/^/verify: listening on /'; \
	 echo "$$listeners" | grep -qE '^(127\.0\.0\.1|\[::1\]|localhost):$(PORT)$$' || { echo "verify: no loopback listener on :$(PORT)"; exit 1; }; \
	 if echo "$$listeners" | grep -vE '^(127\.0\.0\.1|\[::1\]|localhost):' | grep -q .; then echo "verify: :$(PORT) is exposed beyond loopback"; exit 1; fi
	@if [ -n "$(PUBLIC_URL)" ]; then \
	  code=$$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$(PUBLIC_URL)"); \
	  case "$$code" in 000|5*) echo "verify: $(PUBLIC_URL) answered $$code"; exit 1;; esac; \
	  echo "verify: $(PUBLIC_URL) answers $$code"; \
	 else echo "verify: PUBLIC_URL not set, public check skipped"; fi

ifeq ($(UNAME),Darwin)
# Run from CloudCLI's own Shell tab (CLOUDCLI_SERVICE is set by the service script), a restart
# kills that terminal. Then hand the restart to a detached process and exit before it lands.
restart:
	@if [ -n "$$CLOUDCLI_SERVICE" ]; then \
	  echo "Running inside CloudCLI's Shell: this terminal will close in ~2s. Reload the page after."; \
	  nohup sh -c 'sleep 2; launchctl kickstart -k $(LAUNCHD)/$(LABEL)' >/dev/null 2>&1 & \
	else \
	  launchctl kickstart -k $(LAUNCHD)/$(LABEL); sleep 4; \
	  launchctl print $(LAUNCHD)/$(LABEL) | grep -E '^\s*(state|pid) = ' || true; \
	  grep -E 'ui-cleanup|session-radar|env-switcher' $(LOG_DIR)/server.log | tail -4 || true; \
	fi
else
# Run from CloudCLI's own Shell tab, a restart kills that terminal (it lives in the
# service's cgroup). Then hand the restart to systemd and exit before it lands.
restart:
	@if grep -q '/$(SERVICE).service' /proc/self/cgroup; then \
	  echo "Running inside CloudCLI's Shell: this terminal will close in ~2s. Reload the page after."; \
	  systemd-run --user --quiet --collect --on-active=2 systemctl --user restart $(SERVICE); \
	else \
	  systemctl --user restart $(SERVICE); sleep 4; systemctl --user is-active $(SERVICE); \
	  journalctl --user -u $(SERVICE) --since '-15s' -o cat | grep -E 'ui-cleanup|session-radar|env-switcher' || true; \
	fi
endif

deploy: build restart

upgrade: update
	$(MAKE) install build plugins test-custom restart verify
	@echo "Now on $$(git describe --tags --always). Undo with: make rollback"
	@echo "Next: review 'git log --oneline pre-upgrade..HEAD', then 'make push', then 'make sync' on the other machine."

rollback:
	@git rev-parse -q --verify pre-upgrade >/dev/null || { echo "no pre-upgrade tag"; exit 1; }
	@git diff --quiet && git diff --cached --quiet || { echo "Uncommitted changes - commit or stash first"; exit 1; }
	git reset --hard pre-upgrade
	$(MAKE) install build restart verify

ifeq ($(UNAME),Darwin)
logs:
	tail -F $(LOG_DIR)/server.log $(LOG_DIR)/server.error.log

# (Re)install the LaunchAgent from custom/launchd/ and (re)start it. Replaces any older agent
# with the same label (e.g. one running the global npm package).
service:
	@mkdir -p $(dir $(PLIST)) $(LOG_DIR)
	sed -e 's#__APP__#$(CURDIR)#g' -e 's#__HOME__#$(HOME)#g' custom/launchd/$(LABEL).plist.template > $(PLIST)
	chmod 644 $(PLIST)
	-launchctl bootout $(LAUNCHD)/$(LABEL) 2>/dev/null; sleep 1
	launchctl enable $(LAUNCHD)/$(LABEL)
	launchctl bootstrap $(LAUNCHD) $(PLIST)
else
logs:
	journalctl --user -u $(SERVICE) -f -o cat

# (Re)install the systemd unit tracked in custom/systemd/.
service:
	install -m 644 custom/systemd/$(SERVICE).service $(UNIT)
	systemctl --user daemon-reload
	systemctl --user enable $(SERVICE)
endif

# Source custom/claude-guard/claude-guard.sh from ~/.zshrc and ~/.bashrc (whichever exist), once.
claude-guard:
	@line='[ -f $(CURDIR)/custom/claude-guard/claude-guard.sh ] && . $(CURDIR)/custom/claude-guard/claude-guard.sh'; \
	for rc in $(HOME)/.zshrc $(HOME)/.bashrc; do \
	  [ -f "$$rc" ] || continue; \
	  if grep -qF 'custom/claude-guard/claude-guard.sh' "$$rc"; then echo "claude-guard: already in $$rc"; \
	  else printf '\n# CloudCLI: ask before resuming a Claude session already running elsewhere\n%s\n' "$$line" >> "$$rc"; echo "claude-guard: added to $$rc"; fi; \
	done; \
	echo "claude-guard: open a new terminal (or source your rc) to use it"

# End-to-end scenarios against an isolated instance (port 3101, own database); never touches the live service.
e2e:
	node custom/e2e/run.mjs $(E2E_ARGS)

# Unit tests for the custom layer (env-switcher, inject-html); the app's own suites are npm test / test:client.
test-custom:
	npx vitest run --config custom/vitest.config.mjs

push:
	git push origin HEAD

# Run one target on another machine (same checkout path relative to its $HOME).
remote:
	@[ -n "$(HOST)" ] && [ -n "$(TARGET)" ] || { echo "usage: make remote HOST=<ssh host> TARGET=<make target>"; exit 1; }
	ssh $(HOST) 'cd ~/$(REMOTE_DIR) && make $(TARGET)'
