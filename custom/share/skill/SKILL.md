---
name: publish
description: Use when the user asks to publish, share, or make a public link for something produced in this session (a test report with screenshots, a plan or implementation markdown, any generated file or folder), or to extend, expire, list or purge published shares, or asks for a separate share. Copies the files into ~/shares and returns a public https://cloudcli.example.com/share/<id>/<token>/ link that expires after 24h.
---

# Publish artefacts to a public link

The `share` CLI (source: `custom/share/` in the claudecodeui repo, installed with
`make share-install`) copies files into `~/shares/<share_id>/` and the share service serves them
publicly at `<base>/share/<share_id>/<token>/`. The link works for 24h by default; files stay on
disk after expiry and `share extend` brings the same link back.

By default every publish in this Claude session goes into the session's own share (one link,
one token, one expiry). `--separate` makes a new share with its own id and TTL.

## Publishing

1. **Pick exactly what to publish**: the files this conversation produced that the user means.
   An HTML report goes with its asset folder (screenshots, css): publish the folder, not just the
   `.html`, so relative links keep working.
2. **Never publish secrets**: `.env` files, tokens, keys, credentials, auth databases. If a source
   might contain any, ask first.
3. **Choose a tidy layout** with `--dest`:
   - single documents at the root: `plan.md`, `implementation.md`
   - reports under `reports/<name>-<YYYY-MM-DD>/` (e.g. `--dest reports` on a folder named
     `e2e-star-colours-2026-10-02`; copy or rename the folder first if its name is not descriptive)
   - other folders keep their own structure
4. **Give the item a short human title** with `--title` ("E2E report: star colours", "Plan").
   Publishing again with the same title replaces that item.
5. Run it:

   ```sh
   share publish <file-or-folder>... --title "<title>" [--dest <subdir>]
   ```

   Separate share only when the user explicitly asks for one (optionally with their TTL):

   ```sh
   share publish <file-or-folder>... --title "<title>" --separate [--ttl 3d]
   ```

6. Reply with the full item URL and the share URL, each copy-pasteable on its own line, and the
   expiry in EEST (the CLI prints it that way). Mention that the link stops working after expiry
   unless extended.

## Managing shares

| User asks | Run |
|---|---|
| extend (this session's share) | `share extend [--by 24h]` |
| extend another share | `share extend <share_id> [--by 3d]` |
| stop the link now | `share expire [<share_id>]` |
| what did I publish | `share list` |
| link of this session's share | `share url` |
| clean up | `share purge --expired` (deletes files; only when asked) |

Durations: `90m`, `24h`, `3d`. Times the CLI prints are already EEST; report them as printed.

## When it fails

- `no Claude session found` (exit 2): `share` looks for this Claude process's status file in
  `~/.claude/sessions/`. Pass `--session <id>` if you know it, or use `--separate`.
- `command not found: share`: run `make share-install` in the claudecodeui checkout.
- The public link answers 404 for a wrong token, an expired share, or a file that is not in the
  share. A Cloudflare login page instead means the Access bypass for `/share/*` is missing (see
  `custom/share/README.md`).
