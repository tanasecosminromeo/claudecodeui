import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getKeepScreenAwake,
  isWakeLockSupported,
  setKeepScreenAwake,
  subscribeKeepScreenAwake,
  useKeepScreenAwakeSetting,
} from '@/shared/keepScreenAwake';

const STORAGE_KEY = 'keepScreenAwake';

describe('keepScreenAwake store', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as unknown as Record<string, unknown>).wakeLock;
  });

  it('is off by default', () => {
    expect(getKeepScreenAwake()).toBe(false);
  });

  it('stores the flag per device and reads it back', () => {
    setKeepScreenAwake(true);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('true');
    expect(getKeepScreenAwake()).toBe(true);

    setKeepScreenAwake(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('false');
    expect(getKeepScreenAwake()).toBe(false);
  });

  it('keeps the value across a reload of the module', async () => {
    setKeepScreenAwake(true);
    vi.resetModules();
    const reloaded = await import('@/shared/keepScreenAwake');
    expect(reloaded.getKeepScreenAwake()).toBe(true);
  });

  it('notifies subscribers on change and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeKeepScreenAwake(listener);

    setKeepScreenAwake(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setKeepScreenAwake(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('updates every hook reading the switch when one of them sets it', () => {
    const first = renderHook(() => useKeepScreenAwakeSetting());
    const second = renderHook(() => useKeepScreenAwakeSetting());
    expect(first.result.current[0]).toBe(false);
    expect(second.result.current[0]).toBe(false);

    act(() => { first.result.current[1](true); });
    expect(first.result.current[0]).toBe(true);
    expect(second.result.current[0]).toBe(true);
  });

  it('tolerates localStorage throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });

    expect(getKeepScreenAwake()).toBe(false);
    const listener = vi.fn();
    const unsubscribe = subscribeKeepScreenAwake(listener);
    expect(() => setKeepScreenAwake(true)).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('reports support from the presence of navigator.wakeLock', () => {
    expect(isWakeLockSupported()).toBe(false);
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: vi.fn() } });
    expect(isWakeLockSupported()).toBe(true);
  });
});
