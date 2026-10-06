// Pulls status-change events from the Session Radar plugin (GET /events) and sends
// them as notifications. Session Radar sees every Claude session on the host,
// including Shell-tab and terminal ones CloudCLI's own runtime never notifies for.
import { sessionsDb, userDb } from '@/modules/database/index.js';
import { getPluginPort } from '@/modules/plugins/index.js';
import { chatRunRegistry } from '@/modules/websocket/index.js';
import { createNotificationEvent, notifyUserIfEnabled } from '@/modules/notifications/services/notification-orchestrator.service.js';

const POLL_MS = 3000;

export function createSessionRadarRelay({ getPort, fetchEvents, isCloudCliRun, getUserId, notify }) {
  let after = 0;
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
      for (const event of page.events) {
        // CloudCLI's runtime already notifies for chats it runs itself.
        if (userId && !isCloudCliRun(event.sessionId)) notify(userId, event);
      }
      after = page.seq;
    } catch {
      // Plugin restarting or busy: try again next tick.
    }
  };
}

function notifyFromRadar(userId, event) {
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
