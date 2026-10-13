import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useScreenWakeLock } from '@/shared/hooks/useScreenWakeLock';

type FakeSentinel = {
  released: boolean;
  release: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
};

/** A sentinel as the browser hands it out: released flips to true when the browser or release() drops it. */
const makeSentinel = (): FakeSentinel => {
  const sentinel: FakeSentinel = {
    released: false,
    release: vi.fn(async () => {
      sentinel.released = true;
    }),
    addEventListener: vi.fn(),
  };
  return sentinel;
};

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
};

const flush = () => act(async () => { await Promise.resolve(); });

describe('useScreenWakeLock', () => {
  let request: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    request = vi.fn(async () => makeSentinel());
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request } });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as unknown as Record<string, unknown>).wakeLock;
    delete (document as unknown as Record<string, unknown>).visibilityState; // back to jsdom's own getter
  });

  it('requests a screen lock when enabled and visible', async () => {
    renderHook(() => useScreenWakeLock(true));
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('screen');
  });

  it('does nothing when disabled', async () => {
    renderHook(() => useScreenWakeLock(false));
    await flush();
    expect(request).not.toHaveBeenCalled();
  });

  it('releases the lock when switched off', async () => {
    const sentinel = makeSentinel();
    request.mockResolvedValueOnce(sentinel);
    const { rerender } = renderHook(({ enabled }) => useScreenWakeLock(enabled), {
      initialProps: { enabled: true },
    });
    await flush();

    rerender({ enabled: false });
    await flush();
    expect(sentinel.release).toHaveBeenCalledTimes(1);
  });

  it('requests again after hidden then visible, once the browser dropped the lock', async () => {
    const first = makeSentinel();
    const second = makeSentinel();
    request.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    renderHook(() => useScreenWakeLock(true));
    await flush();

    setVisibility('hidden');
    first.released = true; // the browser releases the lock when the page is hidden
    setVisibility('visible');
    await flush();

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not request while hidden', async () => {
    const sentinel = makeSentinel();
    request.mockResolvedValueOnce(sentinel);
    renderHook(() => useScreenWakeLock(true));
    await flush();

    setVisibility('hidden');
    await flush();

    expect(request).toHaveBeenCalledTimes(1);
    expect(sentinel.release).not.toHaveBeenCalled();
  });

  it('releases a lock that resolves after unmount', async () => {
    let resolveRequest: (sentinel: FakeSentinel) => void = () => undefined;
    const late = makeSentinel();
    request.mockReturnValueOnce(new Promise<FakeSentinel>((resolve) => { resolveRequest = resolve; }));

    const { unmount } = renderHook(() => useScreenWakeLock(true));
    unmount();
    await act(async () => { resolveRequest(late); await Promise.resolve(); });

    expect(late.release).toHaveBeenCalledTimes(1);
  });

  it('retries on the next tap after a refused request, and not while a lock is held', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    request.mockRejectedValueOnce(new DOMException('not allowed', 'NotAllowedError'));
    renderHook(() => useScreenWakeLock(true));
    await flush();

    act(() => { document.dispatchEvent(new Event('pointerdown')); });
    await flush();
    act(() => { document.dispatchEvent(new Event('pointerdown')); });
    await flush();

    expect(request).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when the Wake Lock API is missing', () => {
    delete (navigator as unknown as Record<string, unknown>).wakeLock;
    expect(() => renderHook(() => useScreenWakeLock(true))).not.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('warns and does not throw when the request is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    request.mockRejectedValueOnce(new DOMException('not allowed', 'NotAllowedError'));

    expect(() => renderHook(() => useScreenWakeLock(true))).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
