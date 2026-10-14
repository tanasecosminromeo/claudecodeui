import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/modules/i18n';
import AutoStatusSettingsTab from '@/modules/settings/tabs/AutoStatusSettingsTab';
import { api } from '@/shared/api';
import type { SessionStatusChecksView } from '@/shared/types';

// Only the status-checks group is replaced; readApiJson and the rest stay real.
vi.mock('@/shared/api', async (importOriginal) => {
  const actual: Record<string, unknown> = await importOriginal();
  return {
    ...actual,
    api: {
      ...(actual.api as Record<string, unknown>),
      sessionStatusChecks: { get: vi.fn(), saveSettings: vi.fn() },
    },
  };
});

const getMock = vi.mocked(api.sessionStatusChecks.get);
const saveMock = vi.mocked(api.sessionStatusChecks.saveSettings);

const view = (overrides: Partial<SessionStatusChecksView['settings']> = {}): SessionStatusChecksView => ({
  settings: {
    enabled: true,
    freeBlockedCheck: true,
    dailyLimit: 500,
    firstTurn: 3,
    interval: 5,
    ...overrides,
  },
  stats: {
    today: {
      checks: 4,
      automatic: 3,
      autoRename: 1,
      failed: 1,
      inputTokens: 16000,
      outputTokens: 2800,
      costUsd: 0.0234,
      limit: 500,
      used: 3,
    },
    days: Array.from({ length: 14 }, (_, index) => ({
      day: `2026-10-${String(14 - index).padStart(2, '0')}`,
      checks: index === 0 ? 4 : 0,
      inputTokens: index === 0 ? 16000 : 0,
      outputTokens: index === 0 ? 2800 : 0,
      costUsd: index === 0 ? 0.0234 : 0,
    })),
    last: {
      at: '2026-10-14T09:30:00.000Z',
      sessionId: 'session-1',
      reason: 'automatic',
      ok: true,
      durationMs: 1234,
    },
  },
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('AutoStatusSettingsTab', () => {
  beforeEach(() => {
    getMock.mockReset();
    saveMock.mockReset();
  });

  it('renders today usage and the last 14 days from the GET', async () => {
    getMock.mockResolvedValue(jsonResponse(view()));
    render(<AutoStatusSettingsTab />);

    expect(await screen.findByText('3 / 500 automatic checks')).toBeTruthy();
    // The card and today's table row both show the cost.
    expect(screen.getAllByText('$0.02').length).toBeGreaterThan(0);
    expect(screen.getByText('16,000 in · 2,800 out')).toBeTruthy();
    expect(screen.getByText(/Last check:.*automatic · ok · 1234 ms/)).toBeTruthy();
    // One row per local day, zero-filled.
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(15);
    expect(screen.getByRole('switch', { name: 'Enabled' }).getAttribute('aria-checked')).toBe('true');
  });

  it('a toggle sends the PUT with only that setting and shows the answer', async () => {
    getMock.mockResolvedValue(jsonResponse(view()));
    saveMock.mockResolvedValue(jsonResponse(view({ enabled: false })));
    render(<AutoStatusSettingsTab />);

    const toggle = await screen.findByRole('switch', { name: 'Enabled' });
    fireEvent.click(toggle);

    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ enabled: false }));
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Enabled' }).getAttribute('aria-checked')).toBe('false'),
    );
  });

  it('an out-of-range number is refused inline without a request, and a server error shows under its field', async () => {
    getMock.mockResolvedValue(jsonResponse(view()));
    saveMock.mockResolvedValue(
      jsonResponse({ success: false, error: { code: 'INVALID_SESSION_STATUS_SETTINGS', message: 'interval must be from 1 to 100; got 0.' } }, 400),
    );
    render(<AutoStatusSettingsTab />);

    const daily = await screen.findByRole('spinbutton', { name: 'Daily limit' });
    fireEvent.change(daily, { target: { value: '9000' } });
    fireEvent.blur(daily);
    expect(await screen.findByText('A whole number from 0 to 5000.')).toBeTruthy();
    expect(saveMock).not.toHaveBeenCalled();

    const interval = screen.getByRole('spinbutton', { name: 'Then every N turns' });
    fireEvent.change(interval, { target: { value: '5' } });
    fireEvent.blur(interval);
    expect(saveMock).not.toHaveBeenCalled();

    fireEvent.change(interval, { target: { value: '6' } });
    fireEvent.blur(interval);
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith({ interval: 6 }));
    expect(await screen.findByText('interval must be from 1 to 100; got 0.')).toBeTruthy();
  });
});
