import { describe, expect, it } from 'vitest';

import { keyboardOffset } from '@/modules/project-workspace/hooks/useVisualViewportKeyboardOffset';

// Numbers read off an iPhone (layout height 879, keyboard 366) with a debug overlay.
describe('keyboardOffset', () => {
  it('is 0 with the keyboard closed', () => {
    expect(keyboardOffset(879, 879, 0)).toBe(0);
  });

  it('lifts by the keyboard height when iOS did not scroll the page', () => {
    expect(keyboardOffset(879, 513, 0)).toBe(366);
  });

  it('adds nothing when iOS already scrolled the page by the keyboard height', () => {
    // The old innerHeight-based formula gave 366 here on a first open, doubling the lift.
    expect(keyboardOffset(879, 513, 366)).toBe(0);
  });

  it('adds only the part iOS did not scroll', () => {
    expect(keyboardOffset(879, 513, 100)).toBe(266);
  });

  it('never goes negative', () => {
    expect(keyboardOffset(879, 879, 50)).toBe(0);
  });
});
