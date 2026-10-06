import { useEffect, useRef } from 'react';

/** No input for this long and the tab no longer counts as "in use" (the server then sends web push). */
export const IDLE_MS = 2 * 60 * 1000;
const HEARTBEAT_MS = 30 * 1000; // the server forgets a silent tab after 75 s
const CHECK_MS = 5 * 1000;

export function computeActive(visible: boolean, lastInputAt: number, now: number): boolean {
  return visible && now - lastInputAt < IDLE_MS;
}

/** Closes the notifications this device shows for CloudCLI, and the app-icon badge. */
export async function clearShownNotifications(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    const shown = (await registration?.getNotifications()) ?? [];
    shown.forEach((notification) => notification.close());
    await (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.();
  } catch {
    // Not supported here (no service worker, private mode): nothing to clear.
  }
}

/**
 * Tells the server whether this tab is in use (visible, with input in the last
 * 2 minutes), so push notifications wait while the user is on CloudCLI somewhere.
 * Showing the tab also clears the notifications this device is displaying.
 */
export function usePresenceReporter(sendMessage: (message: unknown) => void, isConnected: boolean): void {
  const lastInputRef = useRef(0);

  useEffect(() => {
    lastInputRef.current = Date.now(); // opening the app counts as input
    const onInput = () => { lastInputRef.current = Date.now(); };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        onInput();
        void clearShownNotifications();
      }
    };
    const events = ['keydown', 'pointerdown', 'wheel', 'touchstart'] as const;
    events.forEach((name) => window.addEventListener(name, onInput, { passive: true }));
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState === 'visible') void clearShownNotifications();
    return () => {
      events.forEach((name) => window.removeEventListener(name, onInput));
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  useEffect(() => {
    if (!isConnected) return undefined;
    let sent: boolean | null = null;
    let sentAt = 0;
    const report = () => {
      const now = Date.now();
      const active = computeActive(document.visibilityState === 'visible', lastInputRef.current, now);
      if (active !== sent || (active && now - sentAt >= HEARTBEAT_MS)) {
        sendMessage({ type: 'client.presence', active });
        sent = active;
        sentAt = now;
      }
    };
    const goInactive = () => {
      sendMessage({ type: 'client.presence', active: false });
      sent = false;
    };
    report();
    const timer = setInterval(report, CHECK_MS);
    document.addEventListener('visibilitychange', report);
    window.addEventListener('pagehide', goInactive);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', report);
      window.removeEventListener('pagehide', goInactive);
    };
  }, [isConnected, sendMessage]);
}
