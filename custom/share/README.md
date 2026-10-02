# share: public links for session artefacts

Ask Claude to "publish the report" (or a plan, an implementation note, any file or folder) and it
copies it into `~/shares/<share_id>/` and answers with a link anyone can open, no login:

    https://cloudcli.example.com/share/<share_id>/<token>/          listing of everything shared
    https://cloudcli.example.com/share/<share_id>/<token>/<path>    one file (HTML keeps its relative images)

- One share per Claude session (`share_id` = the session id): every publish in a session lands in
  the same folder, behind the same link. On request, a **separate** share gets its own `x-…` id and TTL.
- Links work for **24h**. Expired links answer 404 but the files stay; `share extend` revives the
  same link. Nothing is deleted unless you ask (`share purge`).
- The CloudCLI sidebar's Conversations tab lists everything as **Artefacts** (plugin
  `../share-artefacts/`, mounted by `../ui-cleanup/cleanup.js`).

## Pieces

| File | What |
|---|---|
| `lib.mjs` | share folders, `share.json`, tokens, expiry, safe path resolution |
| `share.mjs` | the `share` CLI (linked to `~/.local/bin/share`) |
| `sessions.mjs` | session name / status / last message for `share list --with-sessions` |
| `server.mjs` | public server on `127.0.0.1:3002`; every refusal is the same plain 404 |
| `skill/SKILL.md` | the `publish` Claude skill (linked to `~/.claude/skills/publish`) |
| `systemd/claudecodeui-share.service` | user unit template (`__APP__`, `__NODE__` filled in at install) |

`share.json` keeps the token, `sessionId`, `projectPath`, `createdAt`, `expiresAt` and one item per
publish (`title`, `path`, `kind`, `files`, `publishedAt`). It is never served.

## CLI

```sh
share publish <src...> [--title T] [--dest SUBDIR] [--separate] [--ttl 24h] [--session ID]
share extend  [SHARE_ID] [--by 24h]
share expire  [SHARE_ID]
share list    [--json] [--with-sessions]
share url     [SHARE_ID]
share purge   (--expired | SHARE_ID)
```

Without `SHARE_ID` it acts on the current Claude session's share (found by walking up the process
tree to the `claude` process's `~/.claude/sessions/<pid>.json`). Copies, never moves. Publishing the
same `--title` again replaces that item; a name clash with another item gets `-2`, `-3`, …
Symlinks leaving a published folder are skipped. Publishing to an expired share revives it for 24h.

Settings (environment, or the repo `.env`): `SHARE_BASE_URL` (default
`https://cloudcli.example.com`), `SHARE_PORT` (default 3002), `SHARES_DIR` (default `~/shares`).

## Set up on a new machine (Linux, systemd)

1. In the checkout: `make share-install` (also run by `make service`). It links the CLI and the
   skill, installs and starts `claudecodeui-share.service`, and checks it answers on 127.0.0.1:3002.
   If the machine's public host is not cloudcli.example.com, put `SHARE_BASE_URL=https://<host>`
   in `.env` first.
2. Tunnel: add an ingress rule **before** the host's existing rule, sending `^/share/` to the share
   service. For a remotely managed tunnel, with an API token that has Tunnel edit scope
   (fill in your own account and tunnel IDs):

   ```sh
   TOKEN=<Cloudflare API token with Tunnel edit scope>
   URL=https://api.cloudflare.com/client/v4/accounts/<account-id>/cfd_tunnel/<tunnel-id>/configurations
   curl -s -H "Authorization: Bearer $TOKEN" "$URL" | jq '{config: .result.config}' > /tmp/tunnel.json
   jq '.config.ingress |= (map(select(.path != "^/share/")) | (map(.hostname == "cloudcli.example.com") | index(true)) as $i
        | .[:$i] + [{"hostname":"cloudcli.example.com","path":"^/share/","service":"http://localhost:3002"}] + .[$i:])' \
      /tmp/tunnel.json > /tmp/tunnel-new.json
   curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' --data @/tmp/tunnel-new.json "$URL" | jq .success
   ```

3. Cloudflare Access (Zero Trust dashboard by hand, or with a token that has Access edit rights):
   Access → Applications → Add → Self-hosted, domain `cloudcli.example.com`, path `share/*`,
   policy action **Bypass**, include **Everyone**. The more specific path wins over the app that
   protects the whole host.
4. Check, from a private window or another network:

   ```sh
   share publish README.md --title "Smoke test" --separate --ttl 90m --session smoke
   curl -sI <the printed item URL>                  # 200, no Cloudflare login redirect
   curl -sI https://cloudcli.example.com/          # still a 302 to the Access login
   ss -tlnH 'sport = :3002'                         # 127.0.0.1:3002 only
   ```

macOS (the claude-m4 LaunchAgent) is not wired up yet: `make share-install` says so and does nothing.

## Tests

`make test-custom` (vitest, `tests/`): library, CLI, session info and server (including the 404
cases: wrong token, expired, `share.json`, dotfiles, `..` and symlink escapes).

## Remove

`systemctl --user disable --now claudecodeui-share`, delete
`~/.config/systemd/user/claudecodeui-share.service`, `~/.local/bin/share` and
`~/.claude/skills/publish`, drop the `^/share/` tunnel rule and the Access bypass app. `~/shares`
holds the published files.
