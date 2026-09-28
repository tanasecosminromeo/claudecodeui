import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countdown, readCodexUsage, toWindow } from '../codex.mjs';
import { renderUsage } from '../index.js';

const NOW = new Date('2026-09-28T09:00:00Z');
const epoch = (iso) => Date.parse(iso) / 1000;

function tokenCount(timestamp, rateLimits) {
  return JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: {}, rate_limits: rateLimits } });
}

const CODEX_LIMITS = {
  limit_id: 'codex', limit_name: null, plan_type: 'team', rate_limit_reached_type: null,
  primary: { used_percent: 76, window_minutes: 300, resets_at: epoch('2026-09-28T10:52:32Z') },
  secondary: { used_percent: 40, window_minutes: 10080, resets_at: epoch('2026-10-04T08:59:02Z') },
  credits: { has_credits: false, unlimited: false, balance: null },
};

let home;
function writeSession(day, name, lines, mtime) {
  const dir = path.join(home, 'sessions', '2026', '09', day);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (mtime) fs.utimesSync(file, mtime, mtime);
}

beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-')); });
afterEach(() => { fs.rmSync(home, { recursive: true, force: true }); });

describe('readCodexUsage', () => {
  it('is null when Codex is not used on this machine', () => {
    expect(readCodexUsage({ home: path.join(home, 'missing'), now: NOW })).toBeNull();
    fs.mkdirSync(path.join(home, 'sessions'));
    expect(readCodexUsage({ home, now: NOW })).toBeNull();
  });

  it('takes the newest snapshot per limit across session files', () => {
    const older = { ...CODEX_LIMITS, primary: { ...CODEX_LIMITS.primary, used_percent: 10 } };
    writeSession('27', 'a', [
      '{"type":"session_meta","payload":{}}',
      tokenCount('2026-09-27T09:05:20Z', { limit_id: 'premium', primary: null, secondary: null, rate_limit_reached_type: 'workspace_member_credits_depleted' }),
      tokenCount('2026-09-27T20:00:00Z', older),
    ], new Date('2026-09-27T20:00:00Z'));
    writeSession('28', 'b', ['not json', tokenCount('2026-09-28T05:59:56Z', CODEX_LIMITS)], new Date('2026-09-28T06:00:00Z'));

    const usage = readCodexUsage({ home, now: NOW });
    expect(usage.planType).toBe('team');
    expect(usage.observedAt).toBe('2026-09-28T05:59:56.000Z');
    expect(usage.limits.map((l) => l.id)).toEqual(['codex', 'premium']);
    const [codex, premium] = usage.limits;
    expect(codex.primary).toMatchObject({ name: '5-hour', pct: 76, countdown: '1h 53m', expectedPct: null });
    expect(codex.secondary).toMatchObject({ name: '7-day', pct: 40, countdown: '5d 23h', willLastToReset: false });
    expect(premium).toMatchObject({ primary: null, secondary: null, reached: 'workspace member credits depleted' });
  });

  it('drops data older than two weeks', () => {
    writeSession('01', 'old', [tokenCount('2026-09-01T00:00:00Z', CODEX_LIMITS)]);
    expect(readCodexUsage({ home, now: NOW })).toBeNull();
  });
});

describe('toWindow', () => {
  it('reports a window whose reset passed since the snapshot as reset', () => {
    const w = toWindow({ used_percent: 90, window_minutes: 300, resets_at: epoch('2026-09-28T08:00:00Z') }, new Date('2026-09-28T07:00:00Z'), NOW);
    expect(w).toMatchObject({ pct: 0, resetSinceObserved: true, countdown: null });
  });

  it('rejects malformed windows', () => {
    expect(toWindow(null, NOW, NOW)).toBeNull();
    expect(toWindow({ used_percent: '5', window_minutes: 300 }, NOW, NOW)).toBeNull();
  });

  it('formats countdowns', () => {
    expect(countdown(45 * 60000)).toBe('45m');
    expect(countdown((2 * 60 + 5) * 60000)).toBe('2h 5m');
    expect(countdown((26 * 60) * 60000)).toBe('1d 2h');
  });
});

describe('renderUsage', () => {
  const claude = { accounts: [{ number: 1, email: 'a@example.com', active: true, fiveHour: { pct: 10 }, sevenDay: { pct: 20 }, scoped: [] }], fetchedAt: NOW.toISOString() };

  async function render(data) {
    const container = document.createElement('div');
    document.body.append(container);
    const handle = renderUsage(container, { fetchData: async () => data, pollMs: 1e9 });
    await new Promise((r) => { setTimeout(r, 0); });
    const text = container.textContent;
    handle.destroy();
    return text;
  }

  it('adds a Codex card only when Codex data exists', async () => {
    const withCodex = await render({ ...claude, codex: readCodexUsageFixture() });
    expect(withCodex).toContain('Codex');
    expect(withCodex).toContain('premium: workspace member credits depleted');
    const without = await render({ ...claude, codex: null });
    expect(without).not.toContain('Codex');
    expect(without).toContain('Claude plan usage');
  });
});

function readCodexUsageFixture() {
  writeSession('28', 'fx', [
    tokenCount('2026-09-28T05:59:56Z', CODEX_LIMITS),
    tokenCount('2026-09-28T05:00:00Z', { limit_id: 'premium', primary: null, secondary: null, rate_limit_reached_type: 'workspace_member_credits_depleted' }),
  ]);
  return readCodexUsage({ home, now: NOW });
}
