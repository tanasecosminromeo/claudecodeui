import { appConfigDb, sessionStatusChecksDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

/** Settings of the automatic status checks. Read on every check, so a change applies without a restart. */
export type SessionStatusSettings = {
  /** Automatic model checks on or off. Off means no model call except the user's ✨ Auto rename. */
  enabled: boolean;
  /** The free reply check that marks a session `blocked`. */
  freeBlockedCheck: boolean;
  /** Automatic model calls allowed per local day, across all sessions. */
  dailyLimit: number;
  /** The first title and status check runs at this many user turns. */
  firstTurn: number;
  /** Then a status-only check every this many user turns. */
  interval: number;
};

export const SESSION_STATUS_SETTINGS_DEFAULTS: SessionStatusSettings = {
  enabled: true,
  freeBlockedCheck: true,
  dailyLimit: 500,
  firstTurn: 3,
  interval: 5,
};

const SETTING_KEYS = Object.keys(SESSION_STATUS_SETTINGS_DEFAULTS) as Array<keyof SessionStatusSettings>;

type NumericSettingKey = 'dailyLimit' | 'firstTurn' | 'interval';

const RANGES: Record<NumericSettingKey, { min: number; max: number }> = {
  dailyLimit: { min: 0, max: 5000 },
  firstTurn: { min: 1, max: 50 },
  interval: { min: 1, max: 100 },
};

const configKey = (key: keyof SessionStatusSettings): string => `session_status.${key}`;

function readBoolean(key: 'enabled' | 'freeBlockedCheck'): boolean {
  const raw = appConfigDb.get(configKey(key));
  return raw === null ? SESSION_STATUS_SETTINGS_DEFAULTS[key] : raw === 'true';
}

/** A stored number outside its range, or not a whole number, falls back to the default. */
function readNumber(key: NumericSettingKey): number {
  const raw = appConfigDb.get(configKey(key));
  const value = raw === null ? Number.NaN : Number(raw);
  const { min, max } = RANGES[key];
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : SESSION_STATUS_SETTINGS_DEFAULTS[key];
}

/** Reads the stored settings. A missing or unreadable value falls back to its default. */
export function readSessionStatusSettings(): SessionStatusSettings {
  return {
    enabled: readBoolean('enabled'),
    freeBlockedCheck: readBoolean('freeBlockedCheck'),
    dailyLimit: readNumber('dailyLimit'),
    firstTurn: readNumber('firstTurn'),
    interval: readNumber('interval'),
  };
}

function invalid(message: string): AppError {
  return new AppError(message, { code: 'INVALID_SESSION_STATUS_SETTINGS', statusCode: 400 });
}

/**
 * Checks a PUT body. Only known keys with valid values pass; anything else is a
 * 400 that names the field, so a typo never silently does nothing.
 */
export function parseSessionStatusSettingsPatch(body: unknown): Partial<SessionStatusSettings> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw invalid('The request body must be a JSON object of settings.');
  }

  const patch: Partial<SessionStatusSettings> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (!(SETTING_KEYS as string[]).includes(key)) {
      throw invalid(`"${key}" is not an automatic status setting.`);
    }
    if (key === 'enabled' || key === 'freeBlockedCheck') {
      if (typeof value !== 'boolean') {
        throw invalid(`${key} must be true or false.`);
      }
      patch[key] = value;
      continue;
    }

    const numericKey = key as NumericSettingKey;
    const { min, max } = RANGES[numericKey];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw invalid(`${key} must be a whole number from ${min} to ${max}.`);
    }
    if (value < min || value > max) {
      throw invalid(`${key} must be from ${min} to ${max}; got ${value}.`);
    }
    patch[numericKey] = value;
  }
  return patch;
}

/** Saves the given settings and returns every setting as it now reads. */
export function saveSessionStatusSettings(patch: Partial<SessionStatusSettings>): SessionStatusSettings {
  for (const [key, value] of Object.entries(patch) as Array<[keyof SessionStatusSettings, unknown]>) {
    appConfigDb.set(configKey(key), String(value));
  }
  return readSessionStatusSettings();
}

export type SessionStatusStats = {
  today: {
    checks: number;
    automatic: number;
    autoRename: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    limit: number;
    used: number;
  };
  days: Array<{ day: string; checks: number; inputTokens: number; outputTokens: number; costUsd: number }>;
  last: { at: string; sessionId: string; reason: string; ok: boolean; durationMs: number } | null;
};

const STATS_DAYS = 14;

const pad = (value: number): string => String(value).padStart(2, '0');

/** The server's local calendar day as YYYY-MM-DD. */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight that starts the day `daysAgo` days before `now`, as ISO UTC. */
export function localMidnightIso(now: Date, daysAgo: number): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).toISOString();
}

/** Today's totals against the limit, the last 14 local days (zero-filled, newest first) and the last call. */
export function readSessionStatusStats(now: Date = new Date()): SessionStatusStats {
  const settings = readSessionStatusSettings();
  const totals = sessionStatusChecksDb.totalsSince(localMidnightIso(now, 0));
  const used = sessionStatusChecksDb.countAutomaticSince(localMidnightIso(now, 0));

  const byDay = new Map(
    sessionStatusChecksDb
      .dayTotalsSince(localMidnightIso(now, STATS_DAYS - 1))
      .map((row) => [row.day, row]),
  );
  const days = Array.from({ length: STATS_DAYS }, (_, index) => {
    const day = localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - index));
    const row = byDay.get(day);
    return {
      day,
      checks: row?.checks ?? 0,
      inputTokens: row?.inputTokens ?? 0,
      outputTokens: row?.outputTokens ?? 0,
      costUsd: row?.costUsd ?? 0,
    };
  });

  const last = sessionStatusChecksDb.last();
  return {
    today: { ...totals, limit: settings.dailyLimit, used },
    days,
    last: last
      ? { at: last.createdAt, sessionId: last.sessionId, reason: last.reason, ok: last.ok, durationMs: last.durationMs }
      : null,
  };
}

/** The GET and PUT body: the settings and the stats. */
export function readSessionStatusChecksView(): { settings: SessionStatusSettings; stats: SessionStatusStats } {
  return { settings: readSessionStatusSettings(), stats: readSessionStatusStats() };
}
