import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionRadarRelay } from '../services/session-radar-relay.service.js';
import { buildNotificationPayload } from '../services/notification-orchestrator.service.js';

type Ev = { seq: number; kind: string; code: string; sessionId: string; name: string | null; meta: Record<string, unknown> };
const ev = (seq: number, sessionId = 's1'): Ev => ({ seq, kind: 'action_required', code: 'session.waiting', sessionId, name: 'demo', meta: { waitingFor: 'permission prompt' } });

function harness(pages: Array<{ seq: number; events: Ev[] }>, owned = new Set<string>()) {
  const asked: number[] = [];
  const sent: Ev[] = [];
  const poll = createSessionRadarRelay({
    getPort: () => 1234,
    fetchEvents: async (_port: number, after: number) => { asked.push(after); return pages.shift() ?? { seq: after, events: [] }; },
    isCloudCliRun: (id: string) => owned.has(id),
    getUserId: () => 1,
    isUserActive: () => false,
    notify: (_userId: number, e: Ev) => { sent.push(e); },
  });
  return { poll, asked, sent };
}

test('relay forwards new events and pages by seq', async () => {
  const h = harness([{ seq: 2, events: [ev(1), ev(2)] }, { seq: 3, events: [ev(3)] }]);
  await h.poll(); await h.poll();
  assert.deepEqual(h.asked, [0, 2]);
  assert.deepEqual(h.sent.map((e) => e.seq), [1, 2, 3]);
});

test('relay skips sessions CloudCLI runs itself', async () => {
  const h = harness([{ seq: 2, events: [ev(1, 'mine'), ev(2, 'term')] }], new Set(['mine']));
  await h.poll();
  assert.deepEqual(h.sent.map((e) => e.sessionId), ['term']);
});

test('relay starts over when Session Radar restarted (seq went down)', async () => {
  const h = harness([{ seq: 5, events: [ev(5)] }, { seq: 1, events: [] }, { seq: 1, events: [ev(1)] }]);
  await h.poll(); // after = 5
  await h.poll(); // radar says seq 1 < 5: refetch from 0
  assert.deepEqual(h.asked, [0, 5, 0]);
  assert.deepEqual(h.sent.map((e) => e.seq), [5, 1]);
});

test('relay does nothing without the plugin or on a fetch error', async () => {
  const sent: unknown[] = [];
  await createSessionRadarRelay({ getPort: () => null, fetchEvents: async () => { throw new Error('x'); }, isCloudCliRun: () => false, getUserId: () => 1, isUserActive: () => false, notify: (_u: number, e: unknown) => { sent.push(e); } })();
  await createSessionRadarRelay({ getPort: () => 1, fetchEvents: async () => { throw new Error('down'); }, isCloudCliRun: () => false, getUserId: () => 1, isUserActive: () => false, notify: (_u: number, e: unknown) => { sent.push(e); } })();
  assert.equal(sent.length, 0);
});

test('session.waiting has its own notification text', () => {
  const payload = buildNotificationPayload({ provider: 'system', kind: 'action_required', code: 'session.waiting', meta: { waitingFor: 'permission prompt', sessionName: 'demo' } });
  assert.equal(payload.title, 'demo');
  assert.match(payload.body, /Needs input: permission prompt/);
});

test('needs input held back while a device is in use is re-sent once none is, if the session still waits', async () => {
  let active = true;
  const pages = [
    { seq: 2, events: [ev(1, 'a'), ev(2, 'b')], waiting: ['a', 'b'] },
    { seq: 2, events: [], waiting: ['a', 'b'] },
    { seq: 2, events: [], waiting: ['a'] },
    { seq: 2, events: [], waiting: ['a'] },
  ];
  const sent: Array<{ sessionId: string; resend: boolean }> = [];
  const poll = createSessionRadarRelay({
    getPort: () => 1,
    fetchEvents: async () => pages.shift() ?? { seq: 2, events: [], waiting: [] },
    isCloudCliRun: () => false,
    getUserId: () => 1,
    isUserActive: () => active,
    notify: (_u: number, e: Ev, opts?: { resend?: boolean }) => { sent.push({ sessionId: e.sessionId, resend: Boolean(opts?.resend) }); },
  });
  await poll(); // both sent to the orchestrator while active (web push skipped there)
  await poll(); // still active: nothing re-sent
  active = false;
  await poll(); // b was answered meanwhile: only a is re-sent
  await poll(); // once
  assert.deepEqual(sent, [
    { sessionId: 'a', resend: false },
    { sessionId: 'b', resend: false },
    { sessionId: 'a', resend: true },
  ]);
});
