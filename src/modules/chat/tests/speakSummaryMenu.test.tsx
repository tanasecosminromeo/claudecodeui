import assert from 'node:assert/strict';

import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

import '@/modules/i18n';
import type * as Api from '@/shared/api';

const summarizeVoice = vi.fn();

vi.mock('@/shared/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  summarizeVoice: (...args: unknown[]) => summarizeVoice(...args),
}));
vi.mock('@/modules/chat/hooks/useVoiceAvailable', () => ({ useVoiceAvailable: () => true }));

const { default: MessageSpeakControl } = await import('@/modules/chat/transcript/MessageSpeakControl');

beforeEach(() => {
  summarizeVoice.mockReset();
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

test('hovering the speaker offers "Summarised", which shows the summary', async () => {
  summarizeVoice.mockResolvedValue(json(200, { text: 'Both changes work.', prepared: 'summary' }));
  const view = render(<MessageSpeakControl content={'## Report\n\nA long reply.'} />);

  assert.equal(view.queryByRole('menuitem'), null, 'no menu before hovering');
  fireEvent.mouseEnter(view.getByRole('button', { name: 'Read aloud' }).parentElement!);
  const item = view.getByRole('menuitem', { name: 'Summarised' });

  await act(async () => {
    fireEvent.click(item);
  });
  await waitFor(() => assert.match(view.getByTestId('speech-summary').textContent ?? '', /Both changes work\./));
  assert.equal(summarizeVoice.mock.calls[0][0], '## Report\n\nA long reply.');
  assert.ok(view.getByRole('button', { name: 'Read the summary aloud' }), 'the summary can be read on its own');
  assert.equal(view.queryByRole('menuitem'), null, 'the menu closes once the summary opens');

  fireEvent.click(view.getByRole('button', { name: 'Close summary' }));
  assert.equal(view.queryByTestId('speech-summary'), null);
});

test('a backend without summaries says so in the popover', async () => {
  summarizeVoice.mockResolvedValue(json(501, { error: 'This voice backend cannot summarise (no /audio/speech/summary).' }));
  const view = render(<MessageSpeakControl content="Hello." />);
  fireEvent.mouseEnter(view.getByRole('button', { name: 'Read aloud' }).parentElement!);
  await act(async () => {
    fireEvent.click(view.getByRole('menuitem', { name: 'Summarised' }));
  });
  await waitFor(() => assert.match(view.getByTestId('speech-summary').textContent ?? '', /cannot summarise/));
});
