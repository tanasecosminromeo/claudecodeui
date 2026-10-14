import { useEffect, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '@/modules/settings/SettingsCard';
import SettingsRow from '@/modules/settings/SettingsRow';
import SettingsSection from '@/modules/settings/SettingsSection';
import SettingsToggle from '@/modules/settings/SettingsToggle';
import { api, readApiJson } from '@/shared/api';
import type { SessionStatusCheckSettings, SessionStatusChecksView } from '@/shared/types';

type NumberKey = 'dailyLimit' | 'firstTurn' | 'interval';
type SettingKey = keyof SessionStatusCheckSettings;

const NUMBER_RANGES: Record<NumberKey, { min: number; max: number }> = {
  dailyLimit: { min: 0, max: 5000 },
  firstTurn: { min: 1, max: 50 },
  interval: { min: 1, max: 100 },
};

const inputClass =
  'w-24 rounded-md border border-border bg-background px-3 py-2 text-right text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring';

const tdClass = 'px-3 py-2 text-right tabular-nums first:text-left';
const thClass = 'px-3 py-2 text-right text-xs font-medium text-muted-foreground first:text-left';

const formatCost = (usd: number): string => `$${usd.toFixed(2)}`;

/** `2026-10-14` as a short date in the browser's locale. The day is a calendar day, so it is built from its parts. */
function formatDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/** Rendered by Settings for the "auto-status" tab: the automatic checks' settings and their usage. */
export default function AutoStatusSettingsTab() {
  const { t } = useTranslation('settings');
  const [view, setView] = useState<SessionStatusChecksView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [drafts, setDrafts] = useState<Partial<Record<NumberKey, string>>>({});
  const [errors, setErrors] = useState<Partial<Record<SettingKey, string>>>({});
  const [savingKey, setSavingKey] = useState<SettingKey | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.sessionStatusChecks
      .get()
      .then((response) => readApiJson<SessionStatusChecksView>(response))
      .then((data) => {
        if (!cancelled) setView(data);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Saves one setting. The server's answer replaces the view, so the usage is current too. */
  const save = async (patch: Partial<SessionStatusCheckSettings>) => {
    const key = Object.keys(patch)[0] as SettingKey;
    setSavingKey(key);
    setErrors((current) => ({ ...current, [key]: undefined }));
    try {
      const response = await api.sessionStatusChecks.saveSettings(patch);
      const next = await readApiJson<SessionStatusChecksView>(response);
      setView(next);
      setDrafts((current) => ({ ...current, [key]: undefined }));
    } catch (error) {
      setErrors((current) => ({
        ...current,
        [key]: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setSavingKey(null);
    }
  };

  /** Checks the typed number here first, so an out-of-range value never reaches the server. */
  const commitNumber = (key: NumberKey) => {
    if (!view) return;
    const raw = (drafts[key] ?? String(view.settings[key])).trim();
    const value = Number(raw);
    const { min, max } = NUMBER_RANGES[key];
    if (raw === '' || !Number.isInteger(value) || value < min || value > max) {
      setErrors((current) => ({ ...current, [key]: t('autoStatus.checks.range', { min, max }) }));
      return;
    }
    if (value === view.settings[key]) {
      setDrafts((current) => ({ ...current, [key]: undefined }));
      setErrors((current) => ({ ...current, [key]: undefined }));
      return;
    }
    void save({ [key]: value });
  };

  const onNumberKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    }
  };

  const renderNumber = (key: NumberKey, label: string) => {
    const error = errors[key];
    const { min, max } = NUMBER_RANGES[key];
    return (
      <SettingsRow label={label} description={error ? undefined : t('autoStatus.checks.range', { min, max })}>
        <div className="flex flex-col items-end gap-1">
          <input
            type="number"
            inputMode="numeric"
            step={1}
            min={min}
            max={max}
            aria-label={label}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `auto-status-${key}-error` : undefined}
            className={inputClass}
            value={drafts[key] ?? String(view?.settings[key] ?? '')}
            onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
            onBlur={() => commitNumber(key)}
            onKeyDown={onNumberKey}
          />
          {error && (
            <p id={`auto-status-${key}-error`} role="alert" className="max-w-48 text-right text-xs text-red-600 dark:text-red-400">
              {error}
            </p>
          )}
        </div>
      </SettingsRow>
    );
  };

  if (loadFailed) {
    return <p className="text-sm text-red-600 dark:text-red-400">{t('autoStatus.loadError')}</p>;
  }
  if (!view) {
    return <p className="text-sm text-muted-foreground">{t('autoStatus.saving')}</p>;
  }

  const { settings, stats } = view;
  const { today } = stats;
  const usedShare = today.limit > 0 ? Math.min(100, (today.used / today.limit) * 100) : 0;
  const reasonLabel = (reason: string) =>
    reason === 'leaving-blocked'
      ? t('autoStatus.usage.reason.leavingBlocked')
      : reason === 'auto-rename'
        ? t('autoStatus.usage.reason.autoRename')
        : t('autoStatus.usage.reason.automatic');

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="space-y-2">
        <h3 className="text-lg font-medium text-foreground">{t('autoStatus.title')}</h3>
        <p className="text-sm text-muted-foreground">{t('autoStatus.description')}</p>
      </div>

      <SettingsSection title={t('autoStatus.checks.title')}>
        <SettingsCard divided>
          <SettingsRow
            label={t('autoStatus.checks.enabled')}
            description={t('autoStatus.checks.enabledDescription')}
          >
            <SettingsToggle
              checked={settings.enabled}
              onChange={(value) => void save({ enabled: value })}
              ariaLabel={t('autoStatus.checks.enabled')}
              disabled={savingKey === 'enabled'}
            />
          </SettingsRow>
          <SettingsRow label={t('autoStatus.checks.freeBlocked')}>
            <SettingsToggle
              checked={settings.freeBlockedCheck}
              onChange={(value) => void save({ freeBlockedCheck: value })}
              ariaLabel={t('autoStatus.checks.freeBlocked')}
              disabled={savingKey === 'freeBlockedCheck'}
            />
          </SettingsRow>
          {renderNumber('dailyLimit', t('autoStatus.checks.dailyLimit'))}
          {renderNumber('firstTurn', t('autoStatus.checks.firstTurn'))}
          {renderNumber('interval', t('autoStatus.checks.interval'))}
        </SettingsCard>
        <p className="text-sm text-muted-foreground">{t('autoStatus.checks.explainer')}</p>
      </SettingsSection>

      <SettingsSection title={t('autoStatus.usage.title')}>
        <SettingsCard className="space-y-4 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium text-foreground">{t('autoStatus.usage.today')}</span>
            <span className="text-sm tabular-nums text-foreground">
              {t('autoStatus.usage.used', { used: today.used, limit: today.limit })}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full rounded-full bg-primary" style={{ width: `${usedShare}%` }} />
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-muted-foreground">{t('autoStatus.usage.checks')}</dt>
              <dd className="tabular-nums text-foreground">{today.checks.toLocaleString()}</dd>
              <dd className="text-xs text-muted-foreground">
                {t('autoStatus.usage.breakdown', { automatic: today.automatic, autoRename: today.autoRename })}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('autoStatus.usage.failed')}</dt>
              <dd className="tabular-nums text-foreground">{today.failed.toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('autoStatus.usage.tokensColumn')}</dt>
              <dd className="tabular-nums text-foreground">
                {t('autoStatus.usage.tokens', {
                  input: today.inputTokens.toLocaleString(),
                  output: today.outputTokens.toLocaleString(),
                })}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('autoStatus.usage.cost')}</dt>
              <dd className="tabular-nums text-foreground">{formatCost(today.costUsd)}</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            {stats.last
              ? t('autoStatus.usage.last', {
                  when: new Date(stats.last.at).toLocaleString(),
                  reason: reasonLabel(stats.last.reason),
                  status: stats.last.ok ? t('autoStatus.usage.ok') : t('autoStatus.usage.notOk'),
                  ms: stats.last.durationMs,
                })
              : t('autoStatus.usage.none')}
          </p>
        </SettingsCard>

        <div>
          <h4 className="mb-2 text-sm font-medium text-foreground">{t('autoStatus.usage.days')}</h4>
          <div className="max-w-full overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[360px] text-sm">
              <thead className="bg-muted/40">
                <tr>
                  <th className={thClass}>{t('autoStatus.usage.day')}</th>
                  <th className={thClass}>{t('autoStatus.usage.checks')}</th>
                  <th className={thClass}>{t('autoStatus.usage.tokensColumn')}</th>
                  <th className={thClass}>{t('autoStatus.usage.costColumn')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stats.days.map((day) => (
                  <tr key={day.day}>
                    <td className={tdClass}>{formatDay(day.day)}</td>
                    <td className={tdClass}>{day.checks.toLocaleString()}</td>
                    <td className={tdClass}>
                      {day.inputTokens.toLocaleString()} / {day.outputTokens.toLocaleString()}
                    </td>
                    <td className={tdClass}>{formatCost(day.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
