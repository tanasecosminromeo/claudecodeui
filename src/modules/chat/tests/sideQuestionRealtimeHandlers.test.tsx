import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { useChatRealtimeHandlers } from '@/modules/chat/hooks/useChatRealtimeHandlers';
import type { SessionStore } from '@/modules/chat/hooks/useSessionStore';
import type { ProjectSession, ServerEvent } from '@/shared/types';

/**
 * `side_question_updated` carries a sessionId, and the chat's realtime listener
 * treats any kind with a sessionId as transcript activity. It must skip this
 * kind, while an unrelated kind still goes through, which proves the harness
 * reaches the listener at all.
 */

const sideQuestionEvent: ServerEvent = {
  kind: 'side_question_updated',
  sessionId: 'other-session',
  entry: {
    id: 1,
    sessionId: 'other-session',
    question: 'q',
    answer: null,
    status: 'pending',
    source: null,
    error: null,
    createdAt: '2026-10-12T07:00:00.000Z',
    answeredAt: null,
    saved: true,
  },
};

describe('chat realtime handlers', () => {
  const renderHandlers = () => {
    let listener: ((event: ServerEvent) => void) | null = null;
    const appendRealtime = vi.fn();
    const onSessionIdle = vi.fn();

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
      onSessionIdle,
      sessionStore: { appendRealtime } as unknown as SessionStore,
    }));

    return {
      dispatch: (event: ServerEvent) => act(() => { listener?.(event); }),
      appendRealtime,
      onSessionIdle,
    };
  };

  test('side_question_updated is not stored as a transcript row', () => {
    const { dispatch, appendRealtime, onSessionIdle } = renderHandlers();

    dispatch(sideQuestionEvent);

    expect(appendRealtime).not.toHaveBeenCalled();
    expect(onSessionIdle).not.toHaveBeenCalled();
  });

  test('control: an unrelated kind for the same session is stored', () => {
    const { dispatch, appendRealtime } = renderHandlers();

    dispatch({ kind: 'unrelated_probe', sessionId: 'other-session' });

    expect(appendRealtime).toHaveBeenCalledTimes(1);
  });
});
