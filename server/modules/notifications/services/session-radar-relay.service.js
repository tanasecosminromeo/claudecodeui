// Pulls status-change events from the Session Radar plugin (GET /events) and sends
// them as notifications. Session Radar sees every Claude session on the host,
// including Shell-tab and terminal ones CloudCLI's own runtime never notifies for.
import { sessionsDb, userDb } from '@/modules/database/index.js';
import { getPluginPort } from '@/modules/plugins/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/services/notification-orchestrator.service.js';
import { isUserActiveSomewhere } from '@/modules/notifications/services/presence.service.js';

const POLL_MS = 3000;

export function createSessionRadarRelay({ getPort, fetchEvents, isCloudCliRun, getUserId, isUserActive, notify }) {
  let after = 0;
  // "Needs input" events whose web push was skipped because a device was in use. Re-sent once
  // no device is, if Session Radar still lists the session as waiting: walking away from a
  // laptop must not lose a prompt that is still open.
  const held = new Map(); // sessionId -> event
  return async function poll() {
    const port = getPort();
    if (!port) return;
    try {
      let page = await fetchEvents(port, after);
      if (!page || typeof page.seq !== 'number' || !Array.isArray(page.events)) return;
      if (page.seq < after) {
        // The plugin restarted and numbers from 1 again.
        after = 0;
        page = await fetchEvents(port, 0);
        if (!page || !Array.isArray(page.events)) return;
      }
      const userId = getUserId();
      const active = Boolean(userId) && isUserActive(userId);
      for (const event of page.events) {
        // CloudCLI's runtime already notifies for chats it runs itself.
        if (!userId || isCloudCliRun(event.sessionId)) continue;
        notify(userId, event);
        if (active && event.code === 'session.waiting') held.set(event.sessionId, event);
      }
      after = page.seq;
      if (!active && held.size > 0) {
        const waiting = new Set(Array.isArray(page.waiting) ? page.waiting : []);
        for (const [sessionId, event] of held) {
          if (waiting.has(sessionId)) notify(userId, event, { resend: true });
        }
        held.clear();
      }
    } catch {
      // Plugin restarting or busy: try again next tick.
    }
  };
}

function notifyFromRadar(userId, event, { resend = false } = {}) {
  const sessionName = sessionsDb.getSessionName(event.sessionId, 'claude') || event.name || null;
  notifyUserIfEnabled({
    userId,
    event: createNotificationEvent({
      provider: 'claude',
      sessionId: event.sessionId,
      kind: event.kind,
      code: event.code,
      meta: { ...event.meta, sessionName },
      severity: event.kind === 'error' ? 'error' : 'info',
      // A re-send must not be swallowed by the 20 s dedupe of the original.
      dedupeKey: resend ? `radar:resend:${event.sessionId}:${event.seq}` : null,
    }),
  });
}

export function startSessionRadarRelay() {
  const poll = createSessionRadarRelay({
    getPort: () => getPluginPort('session-radar'),
    fetchEvents: async (port, after) => {
      const res = await fetch(`http://127.0.0.1:${port}/events?after=${after}`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? res.json() : null;
    },
    isCloudCliRun: (sessionId) => chatRunRegistry.hasRunForSession(sessionId),
    getUserId: () => userDb.getFirstUser()?.id ?? null,
    isUserActive: (userId) => isUserActiveSomewhere(userId),
    notify: notifyFromRadar,
  });
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await poll(); } finally { running = false; }
  }, POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
