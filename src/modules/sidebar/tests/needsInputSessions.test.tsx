import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import {
  sessionNeedsInput,
  useNeedsInputSessions,
  type SessionStates,
} from '@/modules/sidebar/hooks/useNeedsInputSessions';

const none: SessionStates = { waiting: new Set(), busy: new Set() };
const states = (waiting: string[], busy: string[] = []): SessionStates => ({
  waiting: new Set(waiting),
  busy: new Set(busy),
});

afterEach(() => {
  delete (window as Window & { __uicSessionStates?: unknown }).__uicSessionStates;
});

test('a session a live CLI is waiting on needs input, whatever its status', () => {
  expect(sessionNeedsInput({ id: 'a', status: null }, states(['a']))).toBe(true);
  expect(sessionNeedsInput({ id: 'a', status: 'building' }, states(['a']))).toBe(true);
});

test('a blocked status alone marks the session as needing input', () => {
  expect(sessionNeedsInput({ id: 'a', status: 'blocked' }, none)).toBe(true);
});

test('a blocked status is stale while the session is busy on the answer', () => {
  expect(sessionNeedsInput({ id: 'a', status: 'blocked' }, states([], ['a']))).toBe(false);
});

test('other statuses and unknown sessions do not need input', () => {
  expect(sessionNeedsInput({ id: 'a', status: 'done' }, none)).toBe(false);
  expect(sessionNeedsInput({ id: 'a' }, none)).toBe(false);
  expect(sessionNeedsInput({ id: 'b', status: 'blocked' }, states(['a']))).toBe(true);
  expect(sessionNeedsInput({ id: 'c', status: null }, states(['a']))).toBe(false);
});

test('the hook reads the state published before it mounted', () => {
  (window as Window & { __uicSessionStates?: unknown }).__uicSessionStates = { waiting: ['a'], busy: ['b'] };
  const { result } = renderHook(() => useNeedsInputSessions());
  expect([...result.current.waiting]).toEqual(['a']);
  expect([...result.current.busy]).toEqual(['b']);
});

test('the hook follows uic:waiting and keeps its object when nothing changed', () => {
  const { result } = renderHook(() => useNeedsInputSessions());
  expect(result.current.waiting.size).toBe(0);
  const before = result.current;

  act(() => {
    window.dispatchEvent(new CustomEvent('uic:waiting', { detail: { count: 1, waiting: ['x'], busy: [] } }));
  });
  expect([...result.current.waiting]).toEqual(['x']);

  const after = result.current;
  act(() => {
    window.dispatchEvent(new CustomEvent('uic:waiting', { detail: { count: 1, waiting: ['x'], busy: [] } }));
  });
  expect(result.current).toBe(after);
  expect(after).not.toBe(before);
});

test('the hook stops listening after unmount', () => {
  const { result, unmount } = renderHook(() => useNeedsInputSessions());
  unmount();
  window.dispatchEvent(new CustomEvent('uic:waiting', { detail: { count: 1, waiting: ['x'], busy: [] } }));
  expect(result.current.waiting.size).toBe(0);
});
