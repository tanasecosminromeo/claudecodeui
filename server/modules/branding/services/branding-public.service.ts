import { readFileSync } from 'node:fs';

import {
  BRANDING_ICON_SIZES,
  type BrandingState,
} from '@/modules/branding/services/branding.service.js';

/**
 * Helpers behind the public overrides: the stock PWA files and the app shell
 * are served with the branding applied when a custom name or icon is set, and
 * unchanged otherwise. Every function here is pure apart from the file read in
 * getBrandedIndexHtml.
 */

/** A branding is applied when it has a custom name or a custom icon. */
export function isBranded(branding: BrandingState): boolean {
  return branding.name !== null || branding.iconVersion !== null;
}

/** Picks the smallest stored icon size that is at least `requested`, or the largest one if none is big enough. */
export function pickIconSize(requested: number, sizes: readonly number[] = BRANDING_ICON_SIZES): number {
  const sorted = [...sizes].sort((a, b) => a - b);
  return sorted.find((size) => size >= requested) ?? sorted[sorted.length - 1];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Rewrites the app shell for a branding: the page title and the iOS home-screen
 * title take the custom name, and icon and manifest URLs get `?v=<iconVersion>` so
 * browsers and home screens fetch the new icon. The SVG favicon link is dropped
 * because the public override serves the custom icon as PNG only.
 * Replacers are functions, so a name containing `$&` is inserted literally.
 */
export function renderBrandedIndexHtml(html: string, branding: BrandingState): string {
  let out = html;

  if (branding.name !== null) {
    const name = escapeHtml(branding.name);
    out = out.replace(/<title>[^<]*<\/title>/, () => `<title>${name}</title>`);
    out = out.replace(
      /(<meta\s+name="apple-mobile-web-app-title"\s+content=")[^"]*(")/,
      (_match, before: string, after: string) => `${before}${name}${after}`,
    );
  }

  if (branding.iconVersion !== null) {
    const version = branding.iconVersion;
    out = out.replace(/\s*<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg" \/>/, () => '');
    out = out.replace(
      /href="(\/(?:favicon\.png|manifest\.json|icons\/icon-[^"?]+))"/g,
      (_match, assetPath: string) => `href="${assetPath}?v=${version}"`,
    );
  }

  return out;
}

/** Reads dist/index.html and applies the branding, or returns null when there is nothing to apply. */
export function getBrandedIndexHtml(indexPath: string, branding: BrandingState): string | null {
  if (!isBranded(branding)) {
    return null;
  }
  return renderBrandedIndexHtml(readFileSync(indexPath, 'utf8'), branding);
}

/**
 * Applies the branding to the stock manifest. The name becomes `name` and
 * `short_name`. The icons point at the custom PNGs with a version query and
 * `purpose: "any"`, because the stock maskable purpose would crop the custom art.
 */
export function buildBrandedManifest(
  stock: Record<string, unknown>,
  branding: BrandingState,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = { ...stock };

  if (branding.name !== null) {
    manifest.name = branding.name;
    manifest.short_name = branding.name;
  }

  if (branding.iconVersion !== null && Array.isArray(stock.icons)) {
    manifest.icons = (stock.icons as Array<Record<string, unknown>>).map((icon) => ({
      ...icon,
      src: `${String(icon.src)}?v=${branding.iconVersion}`,
      purpose: 'any',
    }));
  }

  return manifest;
}
