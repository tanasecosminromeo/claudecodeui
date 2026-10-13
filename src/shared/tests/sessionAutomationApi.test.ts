import assert from 'node:assert/strict';

import { afterEach, beforeEach, test, vi } from 'vitest';

import { api } from '@/shared/api';

/** The picker and the Auto rename item reach the server only through these two calls. */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('autoRenameSession posts to the session auto-rename route, id encoded', async () => {
  await api.autoRenameSession('client-a/session 1');

  const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
  assert.equal(url, '/api/providers/sessions/client-a%2Fsession%201/auto-rename');
  assert.equal(options.method, 'POST');
});

test('setSessionStatus puts the chosen key, or null for Auto, to the status route', async () => {
  await api.setSessionStatus('s1', 'testing');
  await api.setSessionStatus('s1', null);

  const [pinnedUrl, pinnedOptions] = fetchMock.mock.calls[0] as [string, RequestInit];
  const [autoUrl, autoOptions] = fetchMock.mock.calls[1] as [string, RequestInit];
  assert.equal(pinnedUrl, '/api/providers/sessions/s1/status');
  assert.equal(pinnedOptions.method, 'PUT');
  assert.deepEqual(JSON.parse(String(pinnedOptions.body)), { status: 'testing' });
  assert.equal(autoUrl, '/api/providers/sessions/s1/status');
  assert.deepEqual(JSON.parse(String(autoOptions.body)), { status: null });
});
