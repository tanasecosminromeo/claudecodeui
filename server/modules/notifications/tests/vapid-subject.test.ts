import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_VAPID_SUBJECT, resolveVapidSubject } from '../vapid-subject.js';

test('VAPID subject comes from VAPID_SUBJECT when it is a mailto or https address', () => {
  assert.equal(resolveVapidSubject({ VAPID_SUBJECT: 'https://ui.example.com' }), 'https://ui.example.com');
  assert.equal(resolveVapidSubject({ VAPID_SUBJECT: ' mailto:me@example.com ' }), 'mailto:me@example.com');
});

test('VAPID subject falls back to a default Apple accepts when unset or invalid', () => {
  assert.equal(resolveVapidSubject({}), DEFAULT_VAPID_SUBJECT);
  assert.equal(resolveVapidSubject({ VAPID_SUBJECT: 'example.com' }), DEFAULT_VAPID_SUBJECT);
  // Apple's push service answers 403 BadJwtToken for a .local mailto subject.
  assert.doesNotMatch(DEFAULT_VAPID_SUBJECT, /\.local\b/);
  assert.match(DEFAULT_VAPID_SUBJECT, /^https:\/\//);
});
