import assert from 'node:assert/strict';

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';

import { resetUserPreferences } from '@/shared/userSettings';
import type { PermissionMode } from '@/shared/types';

/**
 * The composer's permission mode follows through to a session already
 * running. Picking a mode tells the live session (not only the next message),
 * and approving a plan continues in the mode the user wants rather than
 * leaving the CLI to fall back to asking before every edit: the mode shown in
 * the selector, or the one used before plan mode when the selector still says
 * plan.
 */

const okJson = (data: unknown) => Promise.resolve({ ok: true, json: async () => data });

vi.mock('@/shared/api', () => ({
  api: {
    user: {
      preferences: () => okJson({ success: true, preferences: {} }),
      savePreferences: () => okJson({ success: true, preferences: {} }),
    },
    providers: {
      models: () => okJson({ success: true, data: null }),
      capabilities: () => okJson({ success: true, data: null }),
      sessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveModel: () => okJson({ success: true, data: null }),
      setSessionActiveEffort: () => okJson({ success: true, data: null }),
    },
  },
}));

const renderProviderState = async (onPermissionModeSelected?: (mode: PermissionMode) => void) => {
  const { useChatProviderState } = await import('@/modules/chat/hooks/useChatProviderState');
  return renderHook(() =>
    useChatProviderState({ selectedSession: null, selectedProject: null, onPermissionModeSelected }),
  );
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('selected-provider', 'claude');
  resetUserPreferences();
});

afterEach(() => {
  vi.resetModules();
});

test('picking a mode tells the running session', async () => {
  const picked: PermissionMode[] = [];
  const { result } = await renderProviderState((mode) => { picked.push(mode); });

  await act(async () => { result.current.selectPermissionMode('auto'); });
  // Following a plan approval the selector is only brought in line.
  await act(async () => { result.current.selectPermissionMode('acceptEdits', { applyToLiveSession: false }); });

  assert.deepEqual(picked, ['auto']);
  assert.equal(result.current.permissionMode, 'acceptEdits');
});

test('a plan continues in the mode the selector shows', async () => {
  const { result } = await renderProviderState();

  await act(async () => { result.current.selectPermissionMode('plan'); });
  await act(async () => { result.current.selectPermissionMode('auto'); });

  assert.equal(result.current.getModeAfterPlan(), 'auto');
});

test('a plan approved while the selector says plan returns to the mode used before it', async () => {
  const { result } = await renderProviderState();

  await act(async () => { result.current.selectPermissionMode('auto'); });
  await act(async () => { result.current.selectPermissionMode('plan'); });

  assert.equal(result.current.getModeAfterPlan(), 'auto');
});

test('a session that started in plan mode never stays in plan after approval', async () => {
  const { result } = await renderProviderState();

  await act(async () => { result.current.selectPermissionMode('plan'); });

  assert.notEqual(result.current.getModeAfterPlan(), 'plan');
});
