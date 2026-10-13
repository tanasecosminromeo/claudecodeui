import { useSyncExternalStore } from 'react';

/**
 * The "Keep screen awake" switch. It is per device, so it lives in this
 * browser's localStorage and is deliberately not synced to the server the way
 * the other preferences are: a phone that should stay awake is not the laptop.
 */

const STORAGE_KEY = 'keepScreenAwake';

const listeners = new Set<() => void>();

/** True when the browser exposes the Screen Wake Lock API (iOS 18.4+ home-screen PWAs included). */
export const isWakeLockSupported = (): boolean => typeof navigator !== 'undefined' && 'wakeLock' in navigator;

/** Reads the stored switch. Defaults to off, and to off when localStorage is unavailable. */
export const getKeepScreenAwake = (): boolean => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
};

/** Stores the switch and tells every subscriber. A storage failure still updates the open page. */
export const setKeepScreenAwake = (enabled: boolean): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // Private mode or a full quota: the switch still works until the page reloads.
  }
  listeners.forEach((listener) => listener());
};

/** Registers a callback for changes; returns the unsubscribe function for useSyncExternalStore. */
export const subscribeKeepScreenAwake = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Reads and writes the switch from a component; every component using it updates together. */
export const useKeepScreenAwakeSetting = (): [boolean, (enabled: boolean) => void] => {
  const enabled = useSyncExternalStore(subscribeKeepScreenAwake, getKeepScreenAwake, () => false);
  return [enabled, setKeepScreenAwake];
};
