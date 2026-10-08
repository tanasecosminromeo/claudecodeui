# Share artefacts publicly + Artefacts tab

Date: 2026-10-02. Status: draft, awaiting review.

## Goal

When the user asks Claude to "publish" something produced in a session (an e2e report with HTML and
screenshots, a plan `.md`, an implementation `.md`, ...), Claude copies it into a per-session share
folder and returns a public link:

    https://cloudcli.example.com/share/<share_id>/<token>/            -> listing
    https://cloudcli.example.com/share/<share_id>/<token>/<path>      -> file

Anyone with the link can open it, without Cloudflare Access or CloudCLI login. HTML opens with its
relative assets working. The link works for 24h; the user can ask Claude (or click in the UI) to extend
it. The CloudCLI sidebar's Conversations tab becomes an **Artefacts** list of everything published.

## Scope

In: share service, CLI, `publish` skill (tracked in this repo), install target, Artefacts plugin + tab
takeover, tunnel ingress rule, tests, README.

Out: macOS/LaunchAgent install (claude-m4) in this first version; rendering Markdown to HTML (served as
text/plain); automatic deletion of expired shares; authenticated viewing of expired shares.

User does by hand: the Cloudflare Access **Bypass** application for `cloudcli.example.com/share/*`
(the available API token has no Access scope).

## Decisions (from brainstorming)

- One share per Claude session by default; every publish in the session adds to it (same URL, same
  token, one expiry). On explicit request, a **separate** share with its own generated id and TTL.
- Expiry only disables the link; files stay on disk. Extending revives the same URL, even days later.
  Deletion only on explicit `share purge`.
- Share server is a **separate service** (not a route in CloudCLI's `server/index.ts`, not a plugin,
  since plugin routes are behind login).
- Artefacts list: one row per publish, grouped by session, groups ordered by most recent publish.
  Actions: open, copy link, +24h, expire now, open session.
- Skill, CLI, service and docs live in the repo under `custom/share/` and install with one make target.

## Components

### `custom/share/` (new)

```
custom/share/
  README.md
  lib.mjs                 # share.json I/O, token, expiry, path safety, naming
  share.mjs               # CLI (symlinked to ~/.local/bin/share)
  server.mjs              # public share service, 127.0.0.1:3002
  skill/SKILL.md          # the "publish" skill (symlinked to ~/.claude/skills/publish)
  systemd/claudecodeui-share.service
  tests/
```

Plain Node (>= 22), no npm dependencies.

#### Storage

Root: `~/shares/` (override `SHARES_DIR`). One folder per share:

```
~/shares/<share_id>/
  share.json
  <published files...>
```

`share_id`:
- session share: the Claude session id (UUID).
- separate share: `x-` + 8 random base32 chars (e.g. `x-7f3k9q2m`).

`share.json`:

```json
{
  "version": 1,
  "id": "<share_id>",
  "token": "<32 url-safe random chars>",
  "sessionId": "<real Claude session id, also for separate shares>",
  "projectPath": "/path/to/project",
  "separate": false,
  "createdAt": "ISO",
  "expiresAt": "ISO",
  "items": [
    { "title": "E2E report: star colours", "path": "reports/e2e-star-colours-2026-10-02/index.html",
      "kind": "html", "publishedAt": "ISO" }
  ]
}
```

`kind` is one of `html`, `markdown`, `image`, `dir`, `file`. Written atomically (temp file + rename).
Token: 24 random bytes, base64url (32 chars), generated with `crypto.randomBytes`.

#### Session id discovery (CLI)

Walk up the process tree from the CLI (`/proc/<pid>/stat` ppid) until a pid with
`~/.claude/sessions/<pid>.json` is found; use its `sessionId` and `cwd`. `--session <id>` overrides.
If nothing is found: exit 2 with "no Claude session found; pass --session or --separate".

#### CLI: `share`

```
share publish <src...> [--title T] [--dest SUBDIR] [--separate] [--ttl DURATION] [--session ID]
share extend  [SHARE_ID] [--by DURATION]      # default 24h
share expire  [SHARE_ID]
share list    [--json]
share url     [SHARE_ID]
share purge   (--expired | SHARE_ID)
```

- `publish`:
  - Without `--separate`: target is the current session's share; created on first publish with
    `expiresAt = now + ttl` (default 24h). Publishing to an existing share does not change its
    expiry, except that an expired share is extended to `now + 24h` (publishing implies wanting a
    working link).
  - `--separate`: always creates a new share (`x-...`) with `--ttl` (default 24h), records the real
    `sessionId`.
  - Copies (never moves) each `src`: files as-is, directories recursively (so `index.html` +
    `screenshots/` keep relative links). Destination is `<share>/<dest>/<basename>`.
  - Name clash with a file not belonging to the same-titled item: suffix `-2`, `-3`, ... before the
    extension. Never overwrites silently.
  - One `publish` call = one item. Item `path`: the single file; for a directory, its `index.html` if
    present, else the directory. Title defaults to the basename.
  - Re-publishing with the same `--title` in the same share replaces that item (old files removed,
    new ones copied, `publishedAt` updated).
  - Refuses: missing source, source inside `SHARES_DIR`, symlinks pointing outside the source tree
    (copied as regular files would leak; they are skipped with a warning).
  - Prints the item URL, the share URL and the expiry.
- `extend`: `expiresAt = max(now, expiresAt) + by`.
- `expire`: `expiresAt = now`.
- `list --json`: array of shares (all fields except `token` replaced by the full share URL) with
  `expired: boolean`, sorted by latest `publishedAt` desc.
- `purge --expired`: deletes folders of expired shares; `purge ID` deletes one.
- Durations: `24h`, `3d`, `90m`.
- Base URL: `SHARE_BASE_URL` env, else `SHARE_BASE_URL=` line in the repo `.env`, else
  `https://cloudcli.example.com`.

#### Server: `server.mjs`

Listens on `127.0.0.1:${SHARE_PORT:-3002}`. Routes:

- `GET|HEAD /share/<id>/<token>` -> 301 to the same path with trailing slash.
- `GET|HEAD /share/<id>/<token>/` -> HTML listing: share title (session id short form), expiry, the
  items (title, date, link), then the full file tree (links). No `share.json`.
- `GET|HEAD /share/<id>/<token>/<path>` -> file. Directory path without trailing slash -> 301 with
  slash; directory with slash -> its `index.html` if present, else a listing of that directory.
- Everything else -> 404.

Validation per request (reads `share.json` fresh; no cache):
- `id` matches `^[A-Za-z0-9-]{1,64}$`; folder and `share.json` exist.
- token compared with `crypto.timingSafeEqual` (length-checked first).
- `now < expiresAt`.
- `path` is URL-decoded once, normalised; the resolved real path (`fs.realpath`) must be inside the
  share's real path; `share.json` and dotfiles are never served.
- Any failure -> identical plain `404 Not Found`. Unexpected exception -> `500` without details,
  logged to stderr (journal).

Headers on every response: `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy: no-referrer`,
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. Content types from an extension map
(`.html`, `.css`, `.js`, `.json`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.webm`, `.mp4`,
`.pdf`, `.txt`; `.md` -> `text/plain; charset=utf-8`; unknown -> `application/octet-stream`). Files
are streamed.

#### Skill: `skill/SKILL.md` (name `publish`)

Triggers: "publish this/that/the report/the plan", "share ...", "make a link for ...", "extend the
share", "expire the share", "separate share for ...", "list what I published". Instructs Claude to:

1. Identify exactly what to publish (files produced in this conversation); an HTML report includes
   its asset directory.
2. Choose a layout: single documents at the root (`plan.md`, `implementation.md`); reports under
   `reports/<name>-<YYYY-MM-DD>/`; other directories keep their structure (`--dest`).
3. Give each item a short human title (`--title`).
4. Run `share publish ...`; reply with the full URL(s), copy-pasteable, and the expiry in EEST.
5. Use `--separate` (and `--ttl`) only when the user explicitly asks for a separate share.
6. For extend/expire/list, run the matching command and report the result with times in EEST.
7. Never publish secrets (`.env`, tokens, credentials); if a source looks sensitive, ask first.

#### Install: `make share-install`

Idempotent; also called from `make service`:
- `mkdir -p ~/shares ~/.local/bin ~/.claude/skills`
- symlink `custom/share/skill` -> `~/.claude/skills/publish`
- symlink `custom/share/share.mjs` -> `~/.local/bin/share` (executable, `#!/usr/bin/env node`)
- install `custom/share/systemd/claudecodeui-share.service` into `~/.config/systemd/user/`,
  `daemon-reload`, `enable --now`, `restart claudecodeui-share` (never restarts CloudCLI).

Unit: `ExecStart=node <repo>/custom/share/server.mjs`, `EnvironmentFile=-<repo>/.env`,
`Restart=on-failure`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `ReadOnlyPaths=%h/shares`.

#### Tunnel

Add to the remotely managed tunnel serving the host, **before** the
existing `cloudcli.example.com` rule:

```json
{ "hostname": "cloudcli.example.com", "path": "^/share/", "service": "http://localhost:3002" }
```

Done via GET/PUT `/cfd_tunnel/<id>/configurations` (Cloudflare API)
(GET first, insert, PUT the full config back). README documents the same for a new machine.

### `custom/share-artefacts/` (new CloudCLI plugin)

Follows `custom/session-radar` (manifest, `server.mjs`, synced by `custom/ui-cleanup/inject.sh`).
Server only reachable through CloudCLI's authenticated plugin RPC proxy.

- `GET /artefacts` -> runs `share list --json` (via `lib.mjs` import, not a subprocess) and enriches
  each share with session info, reusing session-radar helpers (imported from `../session-radar/`):
  session name, project name, status (`waiting` / `busy` / `idle` / `ended` / `archived`), last
  message (last user-or-assistant text, ~140 chars). Response: groups ordered by latest publish desc,
  items desc.
- `POST /extend {id, by?}`, `POST /expire {id}` -> `lib.mjs`.
- Missing `auth.db` / transcript -> group still returned, without the missing fields.

If importing session-radar helpers proves awkward (they are module-private today), extract the shared
parts into a small `custom/shared/session-info.mjs` used by both plugins.

### `custom/ui-cleanup/cleanup.js`: Conversations -> Artefacts

Same takeover technique as the Running tab -> session-radar list:
- Relabel the Conversations mode tab "Artefacts"; when active, replace its content with the list.
- Group header: session name + project, status badge, last message (muted, one line), expiry in
  EEST or "expired", buttons **Copy link**, **+24h**, **Expire now**, **Open session** (navigates to
  `/session/<id>` in CloudCLI).
- Rows: item title + relative age; click opens the item URL in a new browser tab. Rows of expired
  shares are dimmed; clicking asks "Link expired: extend 24h and open?".
- Separate shares are their own groups with a "separate" tag, showing the originating session.
- Refresh on tab open and every 30 s while visible.
- README notes how to restore the original Conversations list (remove the takeover block).

## Error handling

- CLI: clear messages, non-zero exit codes (1 usage/IO, 2 no session). Atomic writes.
- Server: uniform 404; 500 without details; logs to journal. No restart needed on extend/expire.
- Plugin: degrades to partial info, never drops a share from the list.

## Testing

`make test-custom` (existing vitest config `custom/vitest.config.mjs`), all against a temp `HOME` /
`SHARES_DIR`:

- `lib`: token shape, duration parsing, extend/expire maths, path safety (`..`, `%2e%2e`, absolute
  paths, symlink escaping the share), clash suffixes.
- CLI: first publish creates share; second adds an item; same title replaces; `--separate` creates a
  new share with its own TTL; publishing to an expired share revives it; extend/expire; `list --json`;
  `purge --expired`; no-session error.
- Server (started on a random port): listing; file serving with content types; trailing-slash
  redirects; directory `index.html`; 404 for wrong token, expired, unknown id, `share.json`,
  dotfiles, traversal and symlink escape; security headers present.
- Plugin: grouping, ordering, expired flag, degraded session info.
- E2E: new scenario in `custom/e2e/scenarios/` publishes a fixture report (HTML + image), asserts the
  Artefacts tab shows it under its session and the share URL serves it without CloudCLI login.
- Live (after the user adds the Access Bypass app): share URL returns 200 from a private window;
  `https://cloudcli.example.com/` still requires Access login; `ss -tlnp` shows 3002 bound to
  127.0.0.1 only.
