# env-switcher

Switch between CloudCLI instances (e.g. one per machine, all behind the same Cloudflare Access app) from the
sidebar logo, without reloading any of them.

- The window you open is **home**. Click the logo (it now shows a small `Name ▾` chip) to get the menu.
- Picking another environment loads it into a full-screen iframe on first use and keeps it alive; switching back
  and forth never reloads either app. `×` in the menu unloads one to free memory, `↗` opens it in a new tab.
- **Ctrl+Option+1…9** switches directly (works with the sidebar collapsed, and from inside an embedded env).
- The chip pulses and the menu shows a count when another environment has a session waiting on your input;
  the tab's favicon pulses for all of them.
- Works from any configured origin. Opened any other way (e.g. `http://127.0.0.1:8022`), entries open new tabs.

## Setup

Same value on every machine, in the service's env file (`~/.cloudcli/service.env` on macOS, the repo `.env` on
Linux), then restart:

    ENV_SWITCHER="Dev=https://dev.example.com,M4=https://m4.example.com"

`Name=origin` pairs, up to 9, https only (http only for localhost). The origins must share one registrable
domain (same site) so Cloudflare Access cookies reach the iframes. `ui-cleanup/inject-html.mjs` validates it and
inlines it into `dist/index.html`; unset or invalid leaves the switcher out (the service log says which).

Cloudflare Access app settings this relies on: **Eager redirect cookie** on (one login sets the cookie on every
hostname of the app) and cookie **SameSite = Lax** (sent to same-site iframes, not to other sites).

## Sign-in

Cloudflare's login page refuses to be framed. If an environment's Access session is missing or expired, its
iframe shows **Sign in** (a popup that passes Access and closes), **Open in new tab**, **Retry** and **Back**.
After signing in, returning to the window reconnects it. In an installed PWA (where popups open in the browser,
which doesn't share its cookies) Sign in does a round trip through the other host and comes back.

## Using it from a computer you don't own

The login is protected by your Google passkey/2FA; the session after it is not. Anyone who later uses that
browser, or malware on that machine, can use a live session, and this app is a shell on your machines.

1. Use a private/incognito window only.
2. Sign in to Google with your phone's passkey (QR) and don't let the browser save anything.
3. When done, open `https://<host>/cdn-cgi/access/logout` and close the private window.

Panic buttons: Cloudflare Zero Trust → Users → *Revoke session*; for the app's own tokens,
`sqlite3 ~/.cloudcli/auth.db "delete from app_config where key='jwt_secret'"` and restart the service (every app
login is invalidated).

## Files

- `switcher.js`: one script, three modes: host (top window, menu and iframes), embedded (inside a host's iframe,
  forwards logo clicks, title, path, needs-input count and Access status via `postMessage`), auth landing
  (`?envsw=auth`, reports back to the opener or returns to `?return=`, which must be a configured origin).
- `switcher.css`: chip, menu, stage, overlay, banner; uses the app's theme tokens.
- `tests/`: `make test-custom`.

If the chip stops appearing after an upstream update, check the logo markup in
`src/modules/sidebar/SidebarHeader.tsx` (`LogoBlock`: `div.min-w-0 > [div > svg, h1]`).
