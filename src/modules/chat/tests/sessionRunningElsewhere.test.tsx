import assert from 'node:assert/strict';

import { renderHook } from '@testing-library/react';
import { test } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { NormalizedMessage, ProjectSession, ServerEvent, SessionRunningElsewhereEvent } from '@/shared/types';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';

/**
 * When the server refuses a message because a terminal has the session open,
 * the user is asked whether to take it over. Taking over resends the message,
 * so no error row is left behind; declining keeps the explanation in the chat.
 */

const refusal = {
  kind: 'protocol_error',
  code: 'SESSION_RUNNING_ELSEWHERE',
  error: 'This session is open in a terminal (pid 42). Close it there, or take it over from here.',
  sessionId: 'viewed-session',
  retry: { content: 'hello', options: { model: 'sonnet' } },
} as unknown as ServerEvent;

const renderHandlers = (decide: (event: SessionRunningElsewhereEvent) => boolean) => {
  let listener: ((event: ServerEvent) => void) | null = null;
  const rows: NormalizedMessage[] = [];
  const asked: SessionRunningElsewhereEvent[] = [];

  renderHook(() => useChatRealtimeHandlers({
    isActive: true,
    subscribe: (fn) => {
      listener = fn;
      return () => { listener = null; };
    },
    provider: 'claude',
    selectedSession: { id: 'viewed-session' } as ProjectSession,
    currentSessionId: 'viewed-session',
    setTokenBudget: () => {},
    pendingPermissionRequests: [],
    setPendingPermissionRequests: () => {},
    streamTimerRef: { current: null },
    accumulatedStreamRef: { current: '' },
    lastSeqRef: { current: new Map() },
    statusCheckSentAtRef: { current: new Map() },
    requestLatestMessages: async () => {},
    sessionStore: { appendRealtime: (_sid: string, row: NormalizedMessage) => { rows.push(row); } } as unknown as SessionStore,
    onSessionRunningElsewhere: (event) => {
      asked.push(event);
      return decide(event);
    },
  }));

  return { dispatch: (event: ServerEvent) => listener?.(event), rows, asked };
};

test('taking the session over hands the message back to resend, with no error row', () => {
  const { dispatch, rows, asked } = renderHandlers(() => true);
  dispatch(refusal);

  assert.equal(asked.length, 1);
  assert.equal(asked[0].sessionId, 'viewed-session');
  assert.deepEqual(asked[0].retry, { content: 'hello', options: { model: 'sonnet' } });
  assert.deepEqual(rows, []);
});

test('declining keeps the explanation in the chat', () => {
  const { dispatch, rows } = renderHandlers(() => false);
  dispatch(refusal);

  assert.equal(rows.length, 1);
  assert.match(String(rows[0].content), /open in a terminal/);
});
