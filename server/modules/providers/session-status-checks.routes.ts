import express, { type Request, type Response } from 'express';

import {
  parseSessionStatusSettingsPatch,
  readSessionStatusChecksView,
  saveSessionStatusSettings,
} from '@/modules/providers/services/session-status-checks.service.js';
import { asyncHandler } from '@/shared/utils.js';

/**
 * Mounted at /api/session-status-checks behind authenticateToken, like the other
 * settings endpoints. GET returns `{ settings, stats }`; PUT /settings takes a
 * partial settings object and returns the same shape.
 */
const router = express.Router();

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(readSessionStatusChecksView());
  }),
);

router.put(
  '/settings',
  asyncHandler(async (req: Request, res: Response) => {
    const patch = parseSessionStatusSettingsPatch(req.body);
    saveSessionStatusSettings(patch);
    res.json(readSessionStatusChecksView());
  }),
);

export default router;
