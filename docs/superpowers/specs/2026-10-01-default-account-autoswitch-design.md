# Default account + auto-switch (claude-usage plugin)

Date: 2026-10-01. Status: draft, awaiting review.

## Goal

With more than one Claude account in claude-swap, the user picks one **default** account in the
CloudCLI UI. The system keeps the machine on it until it is about to hit its 5-hour limit, switches to
the best other account before the limit is hit, and comes back when the default's window resets. The
user stops getting rate-limited mid-work and does not switch by hand.

Motivating setup: the default is the small plan (~22 EUR/month), the fallback is Max 20x. The small plan
can go from 90% to 100% within minutes with Opus and large contexts, so the controller must react fast
*while work is happening*, and must stay quiet when nothing is.

## Scope

In: default-account setting and UI, controller, adaptive polling, decision log.
Out (explicitly): moving running sessions to the new account (option "A": new sessions only; the log
tells us what claude-swap does to live processes, then we decide a follow-up); notifying terminal
sessions; Codex; any use of `claude-swap auto` (it would fight this controller; this project is the
controller and only calls `claude-swap switch <n>`).

Note: the plugin already has a manual Switch button (commit 26ae0766). The older "no switch button"
preference no longer holds.

## Components

All in `custom/claude-usage/`, following the existing plugin layout.

- `autoswitch.mjs`
  - `decide(input) -> action` is a pure function. Input: account list with usage, default number,
    controller memory, active-session summary, now. Action: `none`, `switch {to, reason}`,
    `paused {reason}`, plus the next poll delay.
  - `createController(deps)` wires the timer, state file, `claude-swap switch`, session registry reads
    and logging around `decide`.
- `server.mjs` gains routes: `GET/PUT /default` (read / set / clear the default, enable flag),
  `GET /autoswitch/log?n=`, and a `paused` / `autoPausedReason` field per account in the usage payload.
- `index.js` (plugin UI): "Set as default" on each account card and in the popup; a "Default" badge;
  the pause message on the default's card; a small "Auto-switch" on/off toggle.
- State file `~/.claude-code-ui/claude-usage/state.json`: `{ defaultAccount, enabled, leftDefaultAt,
  lastSwitchAt }`. No default set means the controller does nothing (today's behaviour).

## Rules (constants at the top of `autoswitch.mjs`)

| Name | Value |
|---|---|
| `LEAVE_5H` | 95 (%) on the active account's 5-hour window |
| `RETURN_5H_BELOW` | the default's 5h pct is below 50 after its window reset |
| `PAUSE_7D` | 95 (%) on the default's 7-day window |
| `BASE_POLL` | existing 60 s usage cache |
| `FAST_POLL` | 30 s from 90% 5h, 15 s from 95% 5h (floor: Refresh limit of 10 s) |
| `ACTIVE_WINDOW` | 5 min |

1. **Leave.** Active account is the default and its 5h pct >= `LEAVE_5H`: switch to the best fallback =
   most 5h headroom, excluding accounts that claude-swap has disabled, API-key accounts, and any
   account with 7d >= 95%. If there is no viable target: `none`, logged as `blocked`.
2. **Chain.** Active account is a fallback and its 5h pct >= `LEAVE_5H`: switch to the best other
   account (which may be the default if its window has reset).
3. **Return.** Active account is not the default, the default's 5h window has reset since
   `leftDefaultAt` (its `resetsAt` is in the past, or its pct dropped below `RETURN_5H_BELOW`), and the
   default's 7d < `PAUSE_7D`: switch back to the default.
4. **Pause.** The default's 7d >= `PAUSE_7D`: no automatic switches at all, in either direction. Only
   manual switches happen. The default's card shows "Auto-switch paused: 7-day at N%". The pause lifts
   by itself when 7d falls below the threshold.
5. **Manual switches.** Return fires only when the default's window reset after `leftDefaultAt`, so a
   manual move away from the default is not undone on the next tick. A manual switch to the default
   clears `leftDefaultAt`.
6. A switch is never repeated within 5 minutes (cooldown), and never while another switch runs.

## Polling: quiet unless there is activity

The controller must not poll on a timer by itself when nothing is happening (user at 96% going to
sleep: no 5 s polling, and no polling at all).

**Active** = at least one live Claude process (registry `~/.claude/sessions/<pid>.json`, pid alive)
whose `status` is `busy` or `waiting`, or whose `statusUpdatedAt` is within `ACTIVE_WINDOW`.

- **Checks happen on:** (a) a usage fetch caused by the UI (page load, refresh, header meter, existing
  60 s cache), (b) a new Claude session starting (a new registry file appears), and (c) the timer below.
- **The timer runs only while Active** and the active account is the default or a fallback with 5h >=
  90%. Delay 30 s (>= 90%) or 15 s (>= 95%). Below 90%: no timer, only events (a) and (b).
- When no process is Active the timer is cancelled. The next event does one check and re-arms if needed.
- Return (rule 3) needs no timer: it is evaluated at the next event, which is when a new session would
  pick up the account anyway.
- Session start detection: poll the registry directory only while the plugin server is awake due to (a)
  or the timer; do not add a permanent watcher in the first version. (Open item: if starts are missed
  this way, add an `fs.watch` on the registry dir.)

## Logging

`~/.claude-code-ui/claude-usage/autoswitch.log`, JSON Lines, capped at 2 MB with one rotated file.

- Every switch: `{ts, event:"switch", reason, from, to, usage:[all accounts 5h/7d], sessions:[{pid,
  entrypoint, sessionId, status}], exitCode, stderr}`.
- 60 s after every switch: `{event:"post-switch", sessions:[...same fields], activeAccount}` so we can
  see whether live processes changed accounts.
- State changes only (not every tick): `paused`, `resumed`, `blocked`, `armed`, `disarmed`
  (timer on/off) with the reason and the Active summary.
- `GET /autoswitch/log?n=200` returns the last N lines.

No tokens, ever; account emails are allowed (same rule as the rest of the plugin).

## Errors

- `claude-swap` missing, usage fetch failing, or `usageStatus != ok` for the active account: no action,
  log `unknown` once per state change, show "usage unavailable" as today.
- `switch` exits non-zero: log it, keep the state, back off to the cooldown.
- A pinned `CLAUDE_CODE_OAUTH_TOKEN` in the service env makes switching ineffective (existing README
  note): the controller refuses to enable and the UI says why.

## Testing

- Unit (`node --test`, style of `tests/switch.test.mjs`): `decide` for leave, chain, return, pause and
  lift, manual-switch memory, blocked, cooldown, 7d exclusion of targets, and poll-delay selection,
  including "96% and nothing Active => no timer".
- Registry reading: Active detection with busy/waiting/idle/stale/dead-pid fixtures.
- e2e (`make e2e`): a scenario with a fake `claude-swap` on `PATH` returning scripted usage: set a
  default in the UI, push it to 99%, assert one `switch` call and the log line; push the 7d to 95%,
  assert the pause message and no further switches.

## Open items for review

- `LEAVE_5H` was 99, lowered to 95 (2026-10-02) to leave headroom for manual chat use on the default; it is
  a one-line constant.
- Whether to also move running CloudCLI sessions is deferred until we read the post-switch logs.
