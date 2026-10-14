import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { authenticatedFetch, readApiErrorMessage } from '@/shared/api';

/**
 * Per-instance branding (custom app name and icon) from GET /api/branding.
 *
 * The state lives in a module store, so every consumer reads the same value.
 * A copy is mirrored to localStorage so the first paint after a reload already
 * shows the custom icon and name, before the request returns.
 */

export type Branding = {
  name: string | null;
  iconVersion: string | null;
  hasIcon: boolean;
};

/** Fired on window after a settings change so the store re-reads the server state. */
export const BRANDING_CHANGED_EVENT = 'cloudcli:branding-changed';

const STORAGE_KEY = 'cloudcli.branding';
const EMPTY_BRANDING: Branding = { name: null, iconVersion: null, hasIcon: false };

/** Reads and checks the localStorage mirror. A corrupt value falls back to the defaults. */
function readMirror(): Branding {
  if (typeof window === 'undefined') {
    return EMPTY_BRANDING;
  }
  try {
    return normalizeBranding(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null'));
  } catch {
    return EMPTY_BRANDING;
  }
}

/** Accepts the untrusted JSON from the server or the mirror and returns a well-typed Branding. */
export function normalizeBranding(value: unknown): Branding {
  if (!value || typeof value !== 'object') {
    return EMPTY_BRANDING;
  }
  const record = value as Record<string, unknown>;
  const iconVersion = typeof record.iconVersion === 'string' ? record.iconVersion : null;
  const hasIcon = record.hasIcon === true && iconVersion !== null;
  return {
    name: typeof record.name === 'string' && record.name.trim() ? record.name : null,
    iconVersion: hasIcon ? iconVersion : null,
    hasIcon,
  };
}

let snapshot: Branding = readMirror();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Branding {
  return snapshot;
}

/** Stores a new branding, mirrors it to localStorage, and wakes every consumer. */
export function applyBrandingState(value: unknown): void {
  const next = normalizeBranding(value);
  if (next.name === snapshot.name && next.iconVersion === snapshot.iconVersion && next.hasIcon === snapshot.hasIcon) {
    return;
  }
  snapshot = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage can be full or disabled; the in-memory state is still correct.
  }
  applyHeadIcons(next);
  listeners.forEach((listener) => listener());
}

/**
 * Points the open tab's favicon and touch icons at the current icon, so an upload
 * or a reset shows in the browser tab without a reload. The server rewrites the
 * same links in index.html for the next load.
 */
function applyHeadIcons(branding: Branding): void {
  if (typeof document === 'undefined') {
    return;
  }
  const links = document.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="apple-touch-icon"]');
  links.forEach((link) => {
    const base = (link.getAttribute('href') ?? '').split('?')[0];
    if (!base) {
      return;
    }
    link.setAttribute('href', branding.iconVersion ? `${base}?v=${branding.iconVersion}` : base);
  });
}

let inFlightRefresh: Promise<void> | null = null;

/** Re-reads GET /api/branding. Concurrent calls share one request. Failures keep the current state. */
export function refreshBranding(): Promise<void> {
  if (!inFlightRefresh) {
    inFlightRefresh = fetch('/api/branding', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (body) {
          applyBrandingState(body);
        }
      })
      .catch(() => {
        // Offline or server down: keep whatever is shown now.
      })
      .finally(() => {
        inFlightRefresh = null;
      });
  }
  return inFlightRefresh;
}

/** Tells the store that the branding changed on the server, so it re-reads GET /api/branding. */
export function notifyBrandingChanged(): void {
  window.dispatchEvent(new Event(BRANDING_CHANGED_EVENT));
}

if (typeof window !== 'undefined') {
  window.addEventListener(BRANDING_CHANGED_EVENT, () => {
    void refreshBranding();
  });
}

let hasRequestedBranding = false;

/**
 * The current custom name and icon, plus `refresh()`. The first mounted consumer
 * fetches the state once. The rest read the shared value.
 */
export function useBranding(): Branding & { refresh: () => Promise<void> } {
  const branding = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!hasRequestedBranding) {
      hasRequestedBranding = true;
      void refreshBranding();
    }
  }, []);

  return useMemo(
    () => ({ ...branding, refresh: refreshBranding }),
    [branding],
  );
}

/** Icon URL for one size. The version query busts caches after each upload. */
export function brandingIconUrl(size: number, iconVersion: string): string {
  return `/icons/icon-${size}x${size}.png?v=${iconVersion}`;
}

/** Login and loading logo. Served as the custom PNG when a custom icon is set. */
export function brandingLogoUrl(branding: Branding): string {
  return branding.hasIcon && branding.iconVersion ? `/logo.svg?v=${branding.iconVersion}` : '/logo.svg';
}

async function readBrandingResponse(response: Response): Promise<unknown> {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(readApiErrorMessage(body) ?? `Request failed (${response.status}).`);
  }
  return body;
}

/** Uploads a new icon. Throws with the server's message when the image is rejected. */
export async function uploadBrandingIcon(file: File): Promise<void> {
  const form = new FormData();
  form.append('icon', file);
  const response = await authenticatedFetch('/api/branding/icon', { method: 'POST', body: form });
  applyBrandingState(await readBrandingResponse(response));
  notifyBrandingChanged();
}

/** Removes the custom icon and goes back to the stock one. */
export async function resetBrandingIcon(): Promise<void> {
  const response = await authenticatedFetch('/api/branding/icon', { method: 'DELETE' });
  applyBrandingState(await readBrandingResponse(response));
  notifyBrandingChanged();
}

/** Saves the custom app name. An empty string clears it. */
export async function saveBrandingName(name: string): Promise<void> {
  const response = await authenticatedFetch('/api/branding/name', {
    method: 'PUT',
    body: JSON.stringify({ name }),
  });
  applyBrandingState(await readBrandingResponse(response));
  notifyBrandingChanged();
}
