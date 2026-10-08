# Push for every Claude session, quiet while a device is in use, cleared on open

Date: 2026-10-06. Status: draft, awaiting review.

## Goal

Get a push notification on every subscribed device (phones, laptops) when any Claude session on the
host needs input, finishes a long turn, or fails, no matter how it was started (CloudCLI chat, Shell
tab, ssh/mosh terminal, VS Code). Stay quiet while the user is actively using CloudCLI on some device.
Clear CloudCLI's notifications on a device when the app is opened there.

## Decisions (from brainstorming)

- No separate service. Web Push (already upstream, fixed for iPhones by `VAPID_SUBJECT`) is the
  channel; it already sends to every subscription of the user, so each device subscribes once in
  Settings > Notifications.
- Events (all three): needs input; finished, for turns of 3 minutes or more; failed, whatever the length.
- "In use" means: a CloudCLI tab is visible **and** had keyboard, pointer, wheel or touch input in the
  last 2 minutes. If any device of the user is in use, no web push is sent at all (the in-app
  "needs attention" badge covers it). A locked screen counts as not in use (hidden, or no input).
- Clearing: on the device that opens or refocuses CloudCLI, close all CloudCLI notifications it shows.
  Not across devices: iOS requires every push to show a visible notification, so a silent "clear"
  push is not possible.

## Scope

In: Session Radar event detection + relay, Session Radar health check, presence tracking, push gating, clear-on-open, unit tests, a live check on the
iPhone, a README line.

Out: per-device rules (e.g. phone only); quiet hours (the device's Focus / Do Not Disturb handles that);
cross-device clearing; notifications for sessions of other OS users; changes to the desktop (Electron)
channel.

User does by hand: subscribe each laptop browser once (Settings > Notifications > enable push).

## Design

### 1. Detection in Session Radar (no new service)

Session Radar (`custom/session-radar/server.mjs`) already reads Claude Code's status files; it also
detects transitions. New `custom/session-radar/events.mjs`:

- `readStatuses(sessionsDir)`: light read of `~/.claude/sessions/*.json` only (`pid`, `procStart`,
  `sessionId`, `name`, `status` busy/idle/waiting, `waitingFor`), dead or reused pids dropped, then
  aggregated per `sessionId` with the same rank as the list (waiting > busy > idle). Shared with
  `listSessions()` so both read the files the same way. The full `listSessions()` (transcript scan,
  /proc detail) is too heavy to run every 3 s.
- A 3 s loop keeps `sessionId -> { state, busySince }`. The first tick only records state (no pushes
  after a restart). Sessions that disappear are dropped.
- Pure `decideStatusEvent(prev, next, now, lastAssistant)`:

  | Transition | Event | Preference toggle |
  |---|---|---|
  | anything -> `waiting` | kind `action_required`, new code `session.waiting`: "Needs input: <waitingFor>" | Action required |
  | `busy` -> `idle`, last assistant entry has `isApiErrorMessage: true` | `run.failed` with its text | Error |
  | `busy` -> `idle`, busy for >= 180 s | `run.stopped`, stopReason "Finished after N min" | Run stopped |
  | anything else | none | |

  For `busy -> idle` it reads the last 64 KB of the session transcript to find the last
  `type: "assistant"` line.
- Reports every session; skipping the ones CloudCLI notifies for itself happens in the relay (1b),
  which can see CloudCLI's runs. (Comparing CloudCLI's `session_id` with `provider_session_id` is not
  reliable: many chats started from CloudCLI have the same id for both.)
- Events go into a ring buffer (last 200) with an increasing `seq`, served by `GET /events?after=<seq>`
  as `{ seq, events: [{ seq, at, kind, code, sessionId, name, meta }] }`. A restart of the
  plugin resets `seq`; the consumer handles a lower `seq` by starting over (no replay of old events,
  since the first tick is silent).

### 1b. Delivery in the CloudCLI server

New `server/modules/notifications/services/plugin-events-relay.service.js`, started after
`startEnabledPluginServers()`, stopped on shutdown. Every 3 s, if the `session-radar` plugin server is
running (`getPluginPort('session-radar')`), it GETs `http://127.0.0.1:<port>/events?after=<seq>` and
skips events for sessions CloudCLI has a run for (running or kept after completion: the chat run
registry has a run whose app or provider session id equals the event's `sessionId`; CloudCLI notifies
those itself), and passes the others to `notifyUserIfEnabled` for the single user (`userDb.getFirstUser()`), with the CloudCLI session name when
there is one, else the status file's `name`. Existing
preference toggles, 20 s dedupe and payload building apply. If the plugin is not installed or not
running, the relay does nothing.

### 1c. Session Radar health check

While in there, check Session Radar against reality and fix what is wrong: its tests pass; `--dump`
matches `ps` and the status files (no live session missing, no dead one shown live, state and
`waitingFor` right, UI-started chats mapped to their CloudCLI id); the e2e scenario for the Running
view passes. Findings are reported; fixes are separate commits.

### 2. Presence (client -> server)

- Client: a small hook mounted once at app level (next to the WebSocket provider) tracks
  `document.visibilityState` and the last input time (keydown, pointerdown, wheel, touchstart;
  passive listeners, throttled). It sends `{ type: 'client.presence', active }` on the main `/ws`
  socket when `active` changes, and re-sends `active: true` every 30 s while active. It becomes
  inactive on `visibilitychange` to hidden, on `pagehide`, or 2 minutes after the last input.
- Server: `chat-websocket.service.ts` accepts `client.presence` and records it in a new
  `presence.service` (`Map<socket, { userId, active, at }>`, entry removed on socket close).
  `isUserActiveSomewhere(userId)` is true if any entry is `active` and `at` is under 75 s old
  (covers a laptop that went to sleep without closing the socket).

### 3. Push gating

In `notification-orchestrator.service.js`, the `webPush` channel's `isEnabled` also requires
`!isUserActiveSomewhere(userId)`, except for the `push.enabled` confirmation (sent while the user is
obviously on the device that just subscribed). The desktop (Electron) channel is unchanged.

### 4. Clear on open (client)

When the app loads and on every `visibilitychange` to visible, call
`navigator.serviceWorker.ready` -> `registration.getNotifications()` -> `close()` each, and
`navigator.clearAppBadge?.()`. No service worker change needed.

## Error handling

- Unreadable or half-written status/transcript files are skipped for that tick.
- Watcher errors are logged once per kind, never crash the server.
- Presence messages with a non-boolean `active` are ignored.

## Testing

- Unit: `decideStatusEvent` (waiting, finished >= 180 s, short turn ignored, error regardless of
  length, first-scan silence, CloudCLI-owned skip); `/events` seq paging and reset; relay passes
  events through and restarts on a lower seq; presence expiry (75 s) and socket removal;
  orchestrator skips web push while active and sends when not.
- Client unit: presence hook goes inactive after 2 min without input and on hidden.
- Live, on this host: a terminal `claude` asking for a Bash permission -> push on the iPhone with the app
  closed; same with the CloudCLI tab in use on a laptop -> no push; a 3+ minute terminal turn ->
  "finished"; opening the app on the iPhone clears its notifications.
