import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// @ts-expect-error -- web-push ships no type declarations.
import webPush from 'web-push';

import {
  closeConnection,
  initializeDatabase,
  notificationPreferencesDb,
  pushSubscriptionsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';

import {
  buildNotificationPayload,
  createNotificationEvent,
  notifyUserIfEnabled,
  sendWebPushPayload,
} from '../services/notification-orchestrator.service.js';
import { removeClientPresence, setClientPresence } from '../services/presence.service.js';

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'notification-orchestrator-'));
  const databasePath = path.join(temporaryDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('notification payload uses the app session id for a provider session id', async () => {
  await withIsolatedDatabase(() => {
    sessionsDb.createAppSession('app-session-1', 'claude', '/workspace/demo');
    sessionsDb.assignProviderSessionId('app-session-1', 'claude-native-1');

    const payload = buildNotificationPayload({
      provider: 'claude',
      sessionId: 'claude-native-1',
      kind: 'stop',
      code: 'run.stopped',
      meta: { stopReason: 'completed' },
    });

    assert.equal(payload.data.sessionId, 'app-session-1');
    assert.match(payload.data.tag, /app-session-1/);
  });
});

test('a rejected web push is logged with its status and reason, and the subscription is kept', async () => {
  await withIsolatedDatabase(async () => {
    const userId = Number(userDb.createUser('push-user', 'hash').id);
    pushSubscriptionsDb.saveSubscription(userId, 'https://web.push.apple.com/test', 'p256dh', 'auth');

    const originalSend = webPush.sendNotification;
    const originalError = console.error;
    const logged: string[] = [];
    webPush.sendNotification = async () => {
      throw Object.assign(new Error('Received unexpected response code'), {
        statusCode: 403,
        body: '{"reason":"BadJwtToken"}',
      });
    };
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
    try {
      await sendWebPushPayload(userId, { title: 't', body: 'b', data: {} });
    } finally {
      webPush.sendNotification = originalSend;
      console.error = originalError;
    }

    assert.equal(logged.length, 1);
    assert.match(logged[0], /403/);
    assert.match(logged[0], /BadJwtToken/);
    assert.match(logged[0], /web\.push\.apple\.com/);
    assert.equal(pushSubscriptionsDb.getSubscriptions(userId).length, 1);
  });
});

// createNotificationEvent is plain JS: its sessionId default types the field as null.
const waiting = (sessionId: string) => ({
  ...createNotificationEvent({ provider: 'claude', kind: 'action_required', code: 'session.waiting' }),
  sessionId,
});

test('web push waits while a device is in use, except the push-enabled confirmation', async () => {
  await withIsolatedDatabase(async () => {
    const userId = Number(userDb.createUser('presence-user', 'hash').id);
    pushSubscriptionsDb.saveSubscription(userId, 'https://web.push.apple.com/p', 'p256dh', 'auth');
    notificationPreferencesDb.updatePreferences(userId, {
      channels: { inApp: false, webPush: true, desktop: false, sound: false },
      events: { actionRequired: true, stop: true, error: true },
    });
    const sent: string[] = [];
    const originalSend = webPush.sendNotification;
    webPush.sendNotification = async (_sub: unknown, body: string) => { sent.push(JSON.parse(body).data.code); return { statusCode: 201 }; };
    const tab = {};
    try {
      setClientPresence(tab, userId, true);
      notifyUserIfEnabled({ userId, event: waiting('s1') });
      notifyUserIfEnabled({ userId, event: createNotificationEvent({ provider: 'system', code: 'push.enabled' }) });
      setClientPresence(tab, userId, false);
      notifyUserIfEnabled({ userId, event: waiting('s2') });
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      webPush.sendNotification = originalSend;
      removeClientPresence(tab);
    }
    assert.deepEqual(sent, ['push.enabled', 'session.waiting']);
  });
});
