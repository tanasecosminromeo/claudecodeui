import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  brandingIconUrl,
  resetBrandingIcon,
  saveBrandingName,
  uploadBrandingIcon,
  useBranding,
} from '@/shared/branding';
import { Button } from '@/shared/ui';
import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';

const ICON_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml';

/**
 * The app icon and app name for this instance. Rendered inside the Appearance tab.
 * The name saves on blur or Enter, and an empty name goes back to the default.
 */
export default function BrandingSettings() {
  const { t } = useTranslation('settings');
  const branding = useBranding();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [nameDraft, setNameDraft] = useState(branding.name ?? '');
  const [syncedName, setSyncedName] = useState(branding.name);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  // Follow the saved name when it changes elsewhere. This is done during render, not in an effect.
  if (branding.name !== syncedName) {
    setSyncedName(branding.name);
    setNameDraft(branding.name ?? '');
  }

  const runChange = async (change: () => Promise<void>) => {
    setIsBusy(true);
    setError(null);
    try {
      await change();
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : t('appearanceSettings.branding.error'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Clear the value so choosing the same file again still fires onChange.
    event.target.value = '';
    if (file) {
      void runChange(() => uploadBrandingIcon(file));
    }
  };

  const commitName = () => {
    const nextName = nameDraft.trim();
    if (nextName === (branding.name ?? '')) {
      return;
    }
    void runChange(() => saveBrandingName(nextName));
  };

  const handleNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    }
  };

  const previewSrc =
    branding.hasIcon && branding.iconVersion
      ? brandingIconUrl(180, branding.iconVersion)
      : '/icons/icon-192x192.png';

  return (
    <>
      <SettingsCard divided>
        <SettingsRow
          label={t('appearanceSettings.branding.icon.label')}
          description={t('appearanceSettings.branding.icon.description')}
        >
          <div className="flex items-center gap-3">
            <img
              src={previewSrc}
              alt={t('appearanceSettings.branding.icon.previewAlt')}
              className="h-12 w-12 rounded-xl object-cover shadow-sm"
            />
            <div className="flex flex-col gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept={ICON_ACCEPT}
                className="hidden"
                aria-label={t('appearanceSettings.branding.upload')}
                onChange={handleFileChange}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                {t('appearanceSettings.branding.upload')}
              </Button>
              {branding.hasIcon && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => void runChange(resetBrandingIcon)}
                >
                  {t('appearanceSettings.branding.reset')}
                </Button>
              )}
            </div>
          </div>
        </SettingsRow>

        <SettingsRow
          label={t('appearanceSettings.branding.name.label')}
          description={t('appearanceSettings.branding.name.description')}
        >
          <input
            type="text"
            value={nameDraft}
            maxLength={40}
            disabled={isBusy}
            placeholder={t('appearanceSettings.branding.name.placeholder')}
            aria-label={t('appearanceSettings.branding.name.label')}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={handleNameKeyDown}
            className="w-full touch-manipulation rounded-lg border border-input bg-card p-2.5 text-sm text-foreground focus:border-primary focus:ring-1 focus:ring-primary sm:w-64"
          />
        </SettingsRow>
      </SettingsCard>

      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
