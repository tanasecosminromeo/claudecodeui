import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  sessionStatusChecksDb,
} from '@/modules/database/index.js';
import {
  parseSessionStatusSettingsPatch,
  readSessionStatusChecksView,
  readSessionStatusSettings,
  readSessionStatusStats,
  SESSION_STATUS_SETTINGS_DEFAULTS,
  saveSessionStatusSettings,
} from '@/modules/providers/services/session-status-checks.service.js';
import { AppError } from '@/shared/utils.js';

async function withDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'session-status-checks-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/** A fixed local noon, so the day boundaries in these tests do not depend on the clock. */
const NOON = new Date(2026, 9, 14, 12, 0, 0);

function insertCheck(createdAt: Date, overrides: Partial<{ reason: 'automatic' | 'leaving-blocked' | 'auto-rename'; ok: boolean; inputTokens: number; outputTokens: number; costUsd: number | null }> = {}): void {
  sessionStatusChecksDb.insert({
    createdAt: createdAt.toISOString(),
    sessionId: 'session-1',
    reason: overrides.reason ?? 'automatic',
    ok: overrides.ok ?? true,
    durationMs: 900,
    inputTokens: overrides.inputTokens ?? 4000,
    outputTokens: overrides.outputTokens ?? 700,
    costUsd: overrides.costUsd === undefined ? 0.01 : overrides.costUsd,
  });
}

test('settings default to the agreed values when nothing is stored', () => {
  return withDatabase(() => {
    assert.deepEqual(readSessionStatusSettings(), {
      enabled: true,
      freeBlockedCheck: true,
      dailyLimit: 500,
      firstTurn: 3,
      interval: 5,
    });
    assert.deepEqual(SESSION_STATUS_SETTINGS_DEFAULTS, readSessionStatusSettings());
  });
});

test('saved settings are read back, and an unreadable stored value falls back to its default', () => {
  return withDatabase(() => {
    saveSessionStatusSettings({ enabled: false, dailyLimit: 400, interval: 7 });
    assert.equal(readSessionStatusSettings().enabled, false);
    assert.equal(readSessionStatusSettings().dailyLimit, 400);
    assert.equal(readSessionStatusSettings().interval, 7);

    saveSessionStatusSettings({ dailyLimit: 9999 } as never);
    assert.equal(readSessionStatusSettings().dailyLimit, 500);
  });
});

test('the PUT validation accepts valid partial settings', () => {
  assert.deepEqual(parseSessionStatusSettingsPatch({}), {});
  assert.deepEqual(
    parseSessionStatusSettingsPatch({ enabled: false, freeBlockedCheck: true, dailyLimit: 0, firstTurn: 50, interval: 100 }),
    { enabled: false, freeBlockedCheck: true, dailyLimit: 0, firstTurn: 50, interval: 100 },
  );
  assert.deepEqual(parseSessionStatusSettingsPatch({ dailyLimit: 5000 }), { dailyLimit: 5000 });
});

test('the PUT validation rejects out-of-range, mistyped and unknown values with a 400 that names the field', () => {
  const cases: Array<[unknown, string]> = [
    [{ dailyLimit: 5001 }, 'dailyLimit must be from 0 to 5000; got 5001.'],
    [{ dailyLimit: -1 }, 'dailyLimit must be from 0 to 5000; got -1.'],
    [{ dailyLimit: 2.5 }, 'dailyLimit must be a whole number from 0 to 5000.'],
    [{ dailyLimit: '400' }, 'dailyLimit must be a whole number from 0 to 5000.'],
    [{ firstTurn: 0 }, 'firstTurn must be from 1 to 50; got 0.'],
    [{ firstTurn: 51 }, 'firstTurn must be from 1 to 50; got 51.'],
    [{ interval: 101 }, 'interval must be from 1 to 100; got 101.'],
    [{ interval: 0 }, 'interval must be from 1 to 100; got 0.'],
    [{ enabled: 'no' }, 'enabled must be true or false.'],
    [{ freeBlockedCheck: 1 }, 'freeBlockedCheck must be true or false.'],
    [{ dailyLmit: 400 }, '"dailyLmit" is not an automatic status setting.'],
    [[], 'The request body must be a JSON object of settings.'],
    [null, 'The request body must be a JSON object of settings.'],
  ];
  for (const [body, message] of cases) {
    assert.throws(
      () => parseSessionStatusSettingsPatch(body),
      (error: unknown) =>
        error instanceof AppError && error.statusCode === 400 && error.message === message,
      JSON.stringify(body),
    );
  }
});

test('stats: today counts only today, splits the reasons and counts automatic calls against the limit', () => {
  return withDatabase(() => {
    saveSessionStatusSettings({ dailyLimit: 400 });
    insertCheck(new Date(2026, 9, 14, 8));
    insertCheck(new Date(2026, 9, 14, 9), { reason: 'leaving-blocked', ok: false, inputTokens: 0, outputTokens: 0, costUsd: null });
    insertCheck(new Date(2026, 9, 14, 10), { reason: 'auto-rename' });
    insertCheck(new Date(2026, 9, 13, 23));

    const { today } = readSessionStatusStats(NOON);
    assert.deepEqual(today, {
      checks: 3,
      automatic: 2,
      autoRename: 1,
      failed: 1,
      inputTokens: 8000,
      outputTokens: 1400,
      costUsd: 0.02,
      limit: 400,
      used: 2,
    });
  });
});

test('stats: the last 14 local days are zero-filled, newest first, and the last call is reported', () => {
  return withDatabase(() => {
    // Sept 30 is 14 days back, outside the window of today plus 13 days before it.
    insertCheck(new Date(2026, 8, 30, 8));
    insertCheck(new Date(2026, 9, 14, 8), { inputTokens: 100, outputTokens: 10, costUsd: 0.5 });
    insertCheck(new Date(2026, 9, 11, 8), { inputTokens: 200, outputTokens: 20, costUsd: 0.25 });

    const { days, last } = readSessionStatusStats(NOON);
    assert.equal(days.length, 14);
    assert.equal(days[0].day, '2026-10-14');
    assert.equal(days[13].day, '2026-10-01');
    assert.deepEqual(days[0], { day: '2026-10-14', checks: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.5 });
    assert.deepEqual(days[3], { day: '2026-10-11', checks: 1, inputTokens: 200, outputTokens: 20, costUsd: 0.25 });
    assert.deepEqual(days[1], { day: '2026-10-13', checks: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    assert.equal(days.reduce((sum, day) => sum + day.checks, 0), 2);

    assert.equal(last?.sessionId, 'session-1');
    assert.equal(last?.reason, 'automatic');
    assert.equal(last?.ok, true);
    assert.equal(last?.durationMs, 900);
    assert.equal(last?.at, new Date(2026, 9, 11, 8).toISOString());
  });
});

test('stats: an empty table gives zero-filled days and no last call', () => {
  return withDatabase(() => {
    const view = readSessionStatusChecksView();
    assert.equal(view.stats.days.length, 14);
    assert.ok(view.stats.days.every((day) => day.checks === 0 && day.costUsd === 0));
    assert.equal(view.stats.last, null);
    assert.equal(view.stats.today.limit, 500);
    assert.equal(view.stats.today.used, 0);
  });
});

test('each insert prunes rows older than 90 days', () => {
  return withDatabase(() => {
    insertCheck(new Date(Date.now() - 100 * 24 * 60 * 60 * 1000));
    insertCheck(new Date());
    const count = (getConnection().prepare('SELECT COUNT(*) AS count FROM session_status_checks').get() as { count: number }).count;
    assert.equal(count, 1);
  });
});
