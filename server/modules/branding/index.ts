// brandingRoutes: mounted at /api/branding. GET is public; icon and name writes require auth.
export { default as brandingRoutes } from './branding.routes.js';
// createBrandingPublicRouter: mounted by server/index.ts before the static public folder, so a custom icon or name overrides the stock PWA files.
export { createBrandingPublicRouter } from './branding-public.routes.js';
