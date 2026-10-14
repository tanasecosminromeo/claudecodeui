import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

/**
 * Per-instance branding: a custom app name and icon set from Settings → Appearance.
 *
 * Everything lives in one folder, `~/.cloudcli/branding` (override with the
 * `CLOUDCLI_BRANDING_DIR` env var): `branding.json` holds the name and an icon
 * version, and `icon-<size>.png` holds the re-encoded icon at each size. The
 * raw upload is never stored or served.
 */

export const BRANDING_NAME_MAX_LENGTH = 40;
export const BRANDING_ICON_MAX_BYTES = 5 * 1024 * 1024;
export const BRANDING_ICON_SIZES = [32, 64, 72, 96, 128, 144, 152, 180, 192, 384, 512] as const;
export const BRANDING_ICON_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

const STORED_FILE_NAME = 'branding.json';
const ICON_VERSION_PATTERN = /^[a-f0-9]{12}$/;
const LARGEST_ICON_SIZE = BRANDING_ICON_SIZES[BRANDING_ICON_SIZES.length - 1];

/** What the app and the public overrides need to know about the current branding. */
export type BrandingState = {
  name: string | null;
  iconVersion: string | null;
  hasIcon: boolean;
};

type StoredBranding = {
  name: string | null;
  iconVersion: string | null;
};

/** Raised for input the user can fix (bad name, unreadable image). Routes map it to 400. */
export class BrandingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandingValidationError';
  }
}

/** Global branding folder. The env override keeps tests and throwaway instances away from the real data. */
export function getBrandingDir(): string {
  return process.env.CLOUDCLI_BRANDING_DIR || path.join(os.homedir(), '.cloudcli', 'branding');
}

export function iconFileName(size: number): string {
  return `icon-${size}.png`;
}

/**
 * Validates a custom app name. Returns null for an empty name (meaning "use the default"),
 * otherwise the trimmed name. Throws BrandingValidationError for non-strings, names over
 * the length limit, and names containing control characters.
 */
export function normalizeBrandingName(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    throw new BrandingValidationError('Name must be a string.');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (Array.from(trimmed).length > BRANDING_NAME_MAX_LENGTH) {
    throw new BrandingValidationError(`Name must be ${BRANDING_NAME_MAX_LENGTH} characters or fewer.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new BrandingValidationError('Name must not contain control characters.');
  }
  return trimmed;
}

function readStoredBranding(dir: string): StoredBranding {
  let parsed: Partial<Record<keyof StoredBranding, unknown>> = {};
  try {
    parsed = JSON.parse(readFileSync(path.join(dir, STORED_FILE_NAME), 'utf8'));
  } catch {
    // Missing or unreadable file means defaults.
    return { name: null, iconVersion: null };
  }

  let name: string | null = null;
  try {
    name = normalizeBrandingName(parsed.name);
  } catch {
    name = null;
  }
  const iconVersion =
    typeof parsed.iconVersion === 'string' && ICON_VERSION_PATTERN.test(parsed.iconVersion)
      ? parsed.iconVersion
      : null;
  return { name, iconVersion };
}

async function writeStoredBranding(dir: string, stored: StoredBranding): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await writeFileAtomic(path.join(dir, STORED_FILE_NAME), JSON.stringify(stored, null, 2));
}

/** Writes to a temp file in the same folder and renames it over the target, so readers never see a half-written file. */
async function writeFileAtomic(target: string, data: Buffer | string): Promise<void> {
  const tempPath = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await fs.writeFile(tempPath, data);
  await fs.rename(tempPath, target);
}

/**
 * Reads the branding state synchronously. It is a few small reads, and the
 * index.html and manifest handlers need it inside synchronous request code.
 * `hasIcon` requires the icon files to exist, so a half-deleted set reads as no icon.
 */
export function readBrandingState(dir: string = getBrandingDir()): BrandingState {
  const stored = readStoredBranding(dir);
  const hasIcon =
    stored.iconVersion !== null && existsSync(path.join(dir, iconFileName(LARGEST_ICON_SIZE)));
  return {
    name: stored.name,
    iconVersion: hasIcon ? stored.iconVersion : null,
    hasIcon,
  };
}

/** Center-crops the input to a square and re-encodes it as PNG at the given size. */
async function renderIconSize(input: Buffer, size: number): Promise<Buffer> {
  return sharp(input, { density: 300 })
    .resize({ width: size, height: size, fit: 'cover', position: 'centre' })
    .png()
    .toBuffer();
}

/**
 * Turns an uploaded image into the full icon set and makes it the active icon.
 * sharp rejects anything it cannot decode, which is reported as a validation error.
 * The version is a content hash, so a new upload changes the `?v=` on every icon URL.
 */
export async function saveBrandingIcon(input: Buffer, dir: string = getBrandingDir()): Promise<BrandingState> {
  let renders: Array<{ size: number; data: Buffer }>;
  try {
    renders = await Promise.all(
      BRANDING_ICON_SIZES.map(async (size) => ({ size, data: await renderIconSize(input, size) })),
    );
  } catch {
    throw new BrandingValidationError('The file could not be read as an image.');
  }

  const hash = createHash('sha256');
  for (const render of renders) {
    hash.update(render.data);
  }
  const iconVersion = hash.digest('hex').slice(0, 12);

  await fs.mkdir(dir, { recursive: true });
  for (const render of renders) {
    await writeFileAtomic(path.join(dir, iconFileName(render.size)), render.data);
  }

  const current = readStoredBranding(dir);
  await writeStoredBranding(dir, { ...current, iconVersion });
  return readBrandingState(dir);
}

/** Deletes the custom icon files and clears the icon version. The name is kept. */
export async function removeBrandingIcon(dir: string = getBrandingDir()): Promise<BrandingState> {
  for (const size of BRANDING_ICON_SIZES) {
    await fs.rm(path.join(dir, iconFileName(size)), { force: true });
  }
  const current = readStoredBranding(dir);
  await writeStoredBranding(dir, { ...current, iconVersion: null });
  return readBrandingState(dir);
}

/** Saves the custom app name. An empty name clears it back to the default. */
export async function setBrandingName(rawName: unknown, dir: string = getBrandingDir()): Promise<BrandingState> {
  const name = normalizeBrandingName(rawName);
  const current = readStoredBranding(dir);
  await writeStoredBranding(dir, { ...current, name });
  return readBrandingState(dir);
}
