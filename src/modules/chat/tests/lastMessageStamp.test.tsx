import assert from 'node:assert/strict';

import { act, render } from '@testing-library/react';
import { afterEach, test, vi } from 'vitest';

import '@/modules/i18n';
import LastMessageStamp from '@/modules/chat/transcript/LastMessageStamp';
import { formatElapsed, formatFullTimestamp, lastMessageTime } from '@/modules/chat/utils/lastMessageStamp';
import type { ChatMessage } from '@/shared/types';

afterEach(() => {
  vi.useRealTimers();
});

test('formatElapsed starts at the largest non-zero unit and keeps the smaller ones', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(42_000), '42s');
  assert.equal(formatElapsed((3 * 60 + 5) * 1000), '3m 5s');
  assert.equal(formatElapsed(((2 * 24 + 3) * 3600 + 5) * 1000), '2d 3h 0m 5s');
  assert.equal(formatElapsed(-5000), '0s');
});

test('formatFullTimestamp pads every field', () => {
  assert.equal(formatFullTimestamp(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
});

test('lastMessageTime skips trailing messages without a usable timestamp', () => {
  const messages = [
    { type: 'user', content: 'a', timestamp: '2026-10-01T10:00:00.000Z' },
    { type: 'assistant', content: 'b', timestamp: 'not a date' },
  ] as ChatMessage[];
  assert.equal(lastMessageTime(messages), Date.parse('2026-10-01T10:00:00.000Z'));
  assert.equal(lastMessageTime([]), null);
});

test('the stamp shows the full timestamp and keeps its "ago" until the last message changes', () => {
  vi.useFakeTimers();
  const sent = new Date(2026, 9, 1, 12, 0, 0);
  vi.setSystemTime(new Date(sent.getTime() + ((24 + 2) * 3600 + 3 * 60 + 4) * 1000));

  const messages = [{ type: 'assistant', content: 'hi', timestamp: sent.toISOString() }] as ChatMessage[];
  const { getByTestId, rerender } = render(<LastMessageStamp messages={messages} />);
  const stamp = () => getByTestId('last-message-stamp').textContent;
  assert.equal(stamp(), 'last message 2026-10-01 12:00:00 · 1d 2h 3m 4s ago');

  // Time passes, the conversation re-renders: the stamp does not move.
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  rerender(<LastMessageStamp messages={[...messages]} />);
  assert.equal(stamp(), 'last message 2026-10-01 12:00:00 · 1d 2h 3m 4s ago');

  // A new message: measured again from now.
  const reply = new Date(Date.now() - 2000);
  rerender(<LastMessageStamp messages={[...messages, { type: 'user', content: 'again', timestamp: reply.toISOString() }] as ChatMessage[]} />);
  assert.equal(stamp(), `last message ${formatFullTimestamp(reply)} · 2s ago`);
});
