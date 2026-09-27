# commit-guard

Blocks commits and pushes that would publish secrets or denylisted terms (personal info, client names).

- `pre-commit`: added lines and new file names in the index.
- `commit-msg`: the commit message.
- `pre-push`: every commit not yet on any remote, so commits made with `--no-verify` or outside the hooks still get checked.

Two checks run on each:

- **gitleaks** (must be on `PATH`) for API keys, tokens, private keys and similar secrets.
- **Denylist**: one extended regex per line, case-insensitive, `#` comments. It lives in
  `~/.config/commit-guard/denylist` (override with `COMMIT_GUARD_DENYLIST`) and **never in the repo**,
  because the terms themselves are what must not be published.

Also refused: files named like `.env*`, `id_rsa`, `*.pem`, `*.key`, `*.p12`, `credentials.json`, `auth.db`
(`*.example` / `*.sample` / `*.template` are allowed).

Wired in via one line each in `.husky/pre-commit`, `.husky/commit-msg` and `.husky/pre-push`
(husky is installed by `npm ci`). During an upstream merge, the index is diffed against `MERGE_HEAD`,
so only your side is scanned, not upstream's changes.

Write paths as `~` or `%h` (systemd), not `/home/<user>`. If a hit is a false positive and you are sure,
bypass once with `git commit --no-verify` / `git push --no-verify`.
