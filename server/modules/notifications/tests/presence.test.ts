import assert from 'node:assert/strict';
import test from 'node:test';

import { PRESENCE_TTL_MS, isUserActiveSomewhere, removeClientPresence, setClientPresence } from '../services/presence.service.js';

test('a user is active while any socket reports active and recent', () => {
  const laptop = {}; const phone = {};
  setClientPresence(laptop, 1, true, 0);
  setClientPresence(phone, '1', false, 0);
  assert.equal(isUserActiveSomewhere(1, 1000), true);
  assert.equal(isUserActiveSomewhere(2, 1000), false);
  setClientPresence(laptop, 1, false, 2000);
  assert.equal(isUserActiveSomewhere(1, 2000), false);
  removeClientPresence(laptop); removeClientPresence(phone);
});

test('a sleeping laptop that never closed its socket stops counting after the TTL', () => {
  const laptop = {};
  setClientPresence(laptop, 1, true, 0);
  assert.equal(isUserActiveSomewhere(1, PRESENCE_TTL_MS - 1), true);
  assert.equal(isUserActiveSomewhere(1, PRESENCE_TTL_MS), false);
  removeClientPresence(laptop);
  assert.equal(isUserActiveSomewhere(1, 0), false);
});
