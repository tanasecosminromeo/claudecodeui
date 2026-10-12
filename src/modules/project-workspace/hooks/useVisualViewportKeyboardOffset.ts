import { useEffect } from 'react';

/**
 * How far to lift the fixed workspace shell so its bottom meets the top of the keyboard.
 * The shell is sized by the full-height viewport (`clientHeight`), and iOS moves it up by
 * however far it scrolled the page to reveal the input, so only the rest is ours to add.
 * `window.innerHeight` is not used: on newer iOS it shrinks with the keyboard, but sometimes
 * only after the first viewport resize event, which made the lift count the keyboard twice.
 */
export function keyboardOffset(clientHeight: number, visibleHeight: number, scrollY: number) {
  return Math.max(0, Math.round(clientHeight - visibleHeight - scrollY));
}

/** Keeps the fixed workspace shell above the virtual keyboard in iOS Safari. */
export function useVisualViewportKeyboardOffset() {
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) {
      return undefined;
    }

    const updateKeyboardHeight = () => {
      const offset = keyboardOffset(
        document.documentElement.clientHeight,
        visualViewport.height,
        window.scrollY,
      );
      document.documentElement.style.setProperty('--keyboard-height', `${offset}px`);
    };

    visualViewport.addEventListener('resize', updateKeyboardHeight);
    visualViewport.addEventListener('scroll', updateKeyboardHeight);
    return () => {
      visualViewport.removeEventListener('resize', updateKeyboardHeight);
      visualViewport.removeEventListener('scroll', updateKeyboardHeight);
    };
  }, []);
}
