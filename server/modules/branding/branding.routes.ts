import express from 'express';
import multer from 'multer';

import { authenticateToken } from '@/modules/auth/index.js';
import {
  BRANDING_ICON_MAX_BYTES,
  BRANDING_ICON_MIME_TYPES,
  BrandingValidationError,
  getBrandingDir,
  readBrandingState,
  removeBrandingIcon,
  saveBrandingIcon,
  setBrandingName,
} from '@/modules/branding/services/branding.service.js';

const router = express.Router();

// Memory storage: the upload is decoded by sharp and only the resized PNGs reach disk.
const iconUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BRANDING_ICON_MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (BRANDING_ICON_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new BrandingValidationError('Only PNG, JPEG, WebP, and SVG images are allowed.'));
    }
  },
}).single('icon');

/** Public: the app and the login screen read the name and icon version before anyone signs in. */
router.get('/', (req, res) => {
  res.json(readBrandingState(getBrandingDir()));
});

/** Uploads a new app icon. The image is center-cropped and re-encoded at every icon size. */
router.post('/icon', authenticateToken, (req, res) => {
  iconUpload(req, res, async (uploadError: unknown) => {
    if (uploadError) {
      const isTooLarge = (uploadError as { code?: string }).code === 'LIMIT_FILE_SIZE';
      const message = uploadError instanceof Error ? uploadError.message : 'Upload failed.';
      return res.status(isTooLarge ? 413 : 400).json({
        error: isTooLarge ? 'Icon must be 5 MB or smaller.' : message,
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Choose an image to upload.' });
    }

    try {
      const state = await saveBrandingIcon(req.file.buffer, getBrandingDir());
      return res.json(state);
    } catch (error) {
      if (error instanceof BrandingValidationError) {
        return res.status(400).json({ error: error.message });
      }
      const message = error instanceof Error ? error.message : 'Could not save the icon.';
      return res.status(500).json({ error: message });
    }
  });
});

/** Removes the custom icon, going back to the stock icons. */
router.delete('/icon', authenticateToken, async (req, res) => {
  try {
    res.json(await removeBrandingIcon(getBrandingDir()));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not remove the icon.';
    res.status(500).json({ error: message });
  }
});

/** Saves the custom app name. An empty string clears it. */
router.put('/name', authenticateToken, async (req, res) => {
  try {
    res.json(await setBrandingName(req.body?.name, getBrandingDir()));
  } catch (error) {
    if (error instanceof BrandingValidationError) {
      return res.status(400).json({ error: error.message });
    }
    const message = error instanceof Error ? error.message : 'Could not save the name.';
    res.status(500).json({ error: message });
  }
});

export default router;
