import { useEffect } from 'react';

import { isWakeLockSupported } from '@/shared/keepScreenAwake';

/**
 * Holds a screen wake lock while `enabled` is true and the page is visible.
 * Browsers release the lock whenever the page is hidden, so it is requested
 * again on the way back to visible, and on the next tap if there is still no
 * lock (a request refused without a user gesture, or a lock dropped silently).
 * Failures (for example NotAllowedError) are logged and never thrown, because a
 * missing lock must not break the app.
 */
export function useScreenWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !isWakeLockSupported()) {
      return undefined;
    }

    let sentinel: WakeLockSentinel | null = null;
    let active = true;
    let pending = false;

    const release = () => {
      const current = sentinel;
      sentinel = null;
      if (current && !current.released) {
        current.release().catch(() => undefined);
      }
    };

    const request = async () => {
      if (!active || document.visibilityState !== 'visible') {
        return;
      }
      if (pending || (sentinel && !sentinel.released)) {
        return;
      }
      pending = true;
      try {
        const next = await navigator.wakeLock.request('screen');
        // Disabled or unmounted while the request was pending: give the lock back at once.
        if (!active) {
          next.release().catch(() => undefined);
          return;
        }
        sentinel = next;
      } catch (error) {
        console.warn('Could not keep the screen awake:', error);
      } finally {
        pending = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void request();
      }
    };

    const handlePointerDown = () => {
      void request();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('pointerdown', handlePointerDown, { passive: true });
    void request();

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('pointerdown', handlePointerDown);
      release();
    };
  }, [enabled]);
}
