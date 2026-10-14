import { render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { applyBrandingState } from '@/shared/branding';

/**
 * The sidebar logo shows the stock speech-bubble mark when no branding is set, and
 * the custom icon and app name once the instance is branded.
 */

const { LogoBlock } = await import('@/modules/sidebar/SidebarHeader');

const t = ((key: string) => key) as unknown as TFunction;

beforeEach(() => {
  // The hook fetches GET /api/branding once; keep that request offline in tests.
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
});

afterEach(() => {
  applyBrandingState({ name: null, iconVersion: null, hasIcon: false });
  vi.unstubAllGlobals();
});

test('an unbranded logo shows the stock mark and the default title', () => {
  const { container } = render(<LogoBlock t={t} />);

  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('svg')).not.toBeNull();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('app.title');
});

test('a branded logo shows the custom icon and app name', () => {
  applyBrandingState({ name: 'Acme Dev', iconVersion: 'abcdef012345', hasIcon: true });
  const { container } = render(<LogoBlock t={t} />);

  const img = container.querySelector('img');
  expect(img?.getAttribute('src')).toBe('/icons/icon-64x64.png?v=abcdef012345');
  expect(container.querySelector('svg')).toBeNull();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Acme Dev');
});

test('a custom name without an icon keeps the stock mark', () => {
  applyBrandingState({ name: 'Acme Dev', iconVersion: null, hasIcon: false });
  const { container } = render(<LogoBlock t={t} />);

  expect(container.querySelector('img')).toBeNull();
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Acme Dev');
});
