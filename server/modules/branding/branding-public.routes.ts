import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import express, { type NextFunction, type Request, type Response } from 'express';

import {
  getBrandingDir,
  iconFileName,
  readBrandingState,
} from '@/modules/branding/services/branding.service.js';
import {
  buildBrandedManifest,
  getBrandedIndexHtml,
  isBranded,
  pickIconSize,
} from '@/modules/branding/services/branding-public.service.js';

type BrandingPublicOptions = {
  /** The repo's public/ folder, where the stock manifest lives. */
  publicDir: string;
  /** The built app shell folder (dist/), where index.html lives. */
  distDir: string;
  brandingDir?: string;
};

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-cache',
};

/**
 * Public overrides for the stock PWA files. Mounted before express.static(public),
 * so a custom icon or name wins over the stock file. When no branding is set,
 * every handler calls next() and the stock files are served exactly as before.
 */
export function createBrandingPublicRouter(options: BrandingPublicOptions): express.Router {
  const router = express.Router();
  const brandingDir = options.brandingDir ?? getBrandingDir();
  const indexPath = path.join(options.distDir, 'index.html');
  const manifestPath = path.join(options.publicDir, 'manifest.json');

  const sendCustomIcon = (requestedSize: number, res: Response, next: NextFunction) => {
    const state = readBrandingState(brandingDir);
    if (!state.hasIcon) {
      return next();
    }
    const size = pickIconSize(requestedSize);
    res.sendFile(
      path.join(brandingDir, iconFileName(size)),
      { headers: { ...NO_CACHE_HEADERS, 'Content-Type': 'image/png' } },
      (error) => {
        if (error) {
          next(error);
        }
      },
    );
  };

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }

    const requestPath = req.path;

    // Favicons are served at 32px, the size browser tabs use.
    if (requestPath === '/favicon.png' || requestPath === '/favicon.svg') {
      return sendCustomIcon(32, res, next);
    }

    if (requestPath === '/logo.svg') {
      return sendCustomIcon(192, res, next);
    }

    const iconMatch = /^\/icons\/icon-(\d+)x\1\.png$/.exec(requestPath);
    if (iconMatch) {
      return sendCustomIcon(Number(iconMatch[1]), res, next);
    }

    const logoMatch = /^\/logo-(\d+)\.png$/.exec(requestPath);
    if (logoMatch) {
      return sendCustomIcon(Number(logoMatch[1]), res, next);
    }

    if (requestPath === '/manifest.json') {
      const state = readBrandingState(brandingDir);
      if (!isBranded(state)) {
        return next();
      }
      const stock = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      res.set(NO_CACHE_HEADERS);
      return res.json(buildBrandedManifest(stock, state));
    }

    if (requestPath === '/' || requestPath === '/index.html') {
      if (!existsSync(indexPath)) {
        return next();
      }
      const html = getBrandedIndexHtml(indexPath, readBrandingState(brandingDir));
      if (html === null) {
        return next();
      }
      res.set({ ...NO_CACHE_HEADERS, Pragma: 'no-cache', Expires: '0' });
      return res.type('html').send(html);
    }

    return next();
  });

  return router;
}
