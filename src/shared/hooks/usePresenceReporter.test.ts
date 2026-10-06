import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IDLE_MS, computeActive, usePresenceReporter } from '@/shared/hooks/usePresenceReporter';

describe('computeActive', () => {
  it('needs a visible tab and input within 2 minutes', () => {
    expect(computeActive(true, 0, IDLE_MS - 1)).toBe(true);
    expect(computeActive(true, 0, IDLE_MS)).toBe(false);
    expect(computeActive(false, 0, 1)).toBe(false);
  });
});

describe('usePresenceReporter', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reports active, goes inactive after 2 minutes without input, active again on input', () => {
    const send = vi.fn();
    renderHook(() => usePresenceReporter(send, true));
    expect(send).toHaveBeenLastCalledWith({ type: 'client.presence', active: true });
    act(() => { vi.advanceTimersByTime(IDLE_MS + 5000); });
    expect(send).toHaveBeenLastCalledWith({ type: 'client.presence', active: false });
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown')); vi.advanceTimersByTime(5000); });
    expect(send).toHaveBeenLastCalledWith({ type: 'client.presence', active: true });
  });

  it('reports inactive at once when the tab is hidden', () => {
    const send = vi.fn();
    renderHook(() => usePresenceReporter(send, true));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(send).toHaveBeenLastCalledWith({ type: 'client.presence', active: false });
    delete (document as unknown as Record<string, unknown>).visibilityState; // back to jsdom's own getter
  });

  it('sends nothing while disconnected', () => {
    const send = vi.fn();
    renderHook(() => usePresenceReporter(send, false));
    act(() => { vi.advanceTimersByTime(60000); });
    expect(send).not.toHaveBeenCalled();
  });
});
