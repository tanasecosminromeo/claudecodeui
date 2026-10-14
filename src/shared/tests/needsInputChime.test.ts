import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type * as ChimeNamespace from '@/shared/needsInputChime';
import type * as UtilsNamespace from '@/shared/utils';

vi.mock('@/shared/utils', () => ({
  playNotificationSound: vi.fn(() => Promise.resolve()),
}));

let chime: typeof ChimeNamespace;
let playNotificationSound: ReturnType<typeof vi.fn>;
let stop: () => void;

const publish = (waiting: string[]) => {
  window.dispatchEvent(new CustomEvent('uic:waiting', { detail: { count: waiting.length, waiting, busy: [] } }));
};

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  delete (window as Window & { __uicSessionStates?: unknown }).__uicSessionStates;
  const utils: typeof UtilsNamespace = await import('@/shared/utils');
  playNotificationSound = utils.playNotificationSound as unknown as ReturnType<typeof vi.fn>;
  playNotificationSound.mockClear();
  chime = await import('@/shared/needsInputChime');
  stop = chime.startNeedsInputChime();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe('needs-input chime', () => {
  test('the first published state is a baseline and does not chime', () => {
    publish(['a', 'b']);
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  test('a baseline already present at start does not chime', () => {
    stop();
    (window as Window & { __uicSessionStates?: unknown }).__uicSessionStates = { waiting: ['a'], busy: [] };
    stop = chime.startNeedsInputChime();
    publish(['a']);
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  test('a session that newly starts waiting chimes once', () => {
    publish([]);
    publish(['a']);
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  test('a session that keeps waiting does not chime again', () => {
    publish([]);
    publish(['a']);
    publish(['a']);
    publish(['a']);
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  test('a session that stops waiting and returns chimes again', () => {
    publish([]);
    publish(['a']);
    publish([]);
    publish(['a']);
    expect(playNotificationSound).toHaveBeenCalledTimes(2);
  });

  test('a session chimed live within 30 s does not chime from the radar', () => {
    publish([]);
    chime.noteNeedsInputChime('a');
    expect(playNotificationSound).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    publish(['a']);
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  test('a live chime older than 30 s does not suppress the radar chime', () => {
    publish([]);
    chime.noteNeedsInputChime('a');
    vi.advanceTimersByTime(30_000);
    publish(['a']);
    expect(playNotificationSound).toHaveBeenCalledTimes(2);
  });

  test('several new sessions in one update make a single chime', () => {
    publish([]);
    publish(['a', 'b', 'c']);
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  test('stopping the watcher removes the listener', () => {
    publish([]);
    stop();
    publish(['a']);
    expect(playNotificationSound).not.toHaveBeenCalled();
    stop = chime.startNeedsInputChime();
  });
});
