import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SRC from '../voice-shortcut.js?raw';

// The composer as the app renders it: a textarea and a lucide Mic icon inside a button.
// While recording the icon becomes a Square; while transcribing, a Loader2.
function composer(icon = 'mic') {
  document.body.innerHTML = `
    <textarea id="prompt"></textarea>
    <button id="stop-generating"><svg class="lucide lucide-square"></svg></button>
    <span><button id="mic"><svg class="lucide lucide-${icon}"></svg></button></span>`;
  const mic = document.getElementById('mic');
  const clicks = vi.fn();
  mic.addEventListener('click', clicks);
  return { mic, clicks, prompt: document.getElementById('prompt') };
}

function setIcon(button, icon) {
  button.innerHTML = `<svg class="lucide lucide-${icon}"></svg>`;
}

function press(init = {}) {
  const ev = new KeyboardEvent('keydown', { code: 'Space', key: ' ', ctrlKey: true, bubbles: true, cancelable: true, ...init });
  (document.activeElement || document.body).dispatchEvent(ev);
  return ev;
}

describe('voice shortcut (Ctrl+Space / Option+Space toggles the composer mic)', () => {
  beforeAll(() => { window.eval(SRC); });
  beforeEach(() => { document.body.innerHTML = ''; });

  it('starts recording and keeps focus in the prompt', () => {
    const { clicks, prompt } = composer();
    prompt.focus();
    const ev = press();
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(prompt);
  });

  it('stops the same button while recording, not the other Square button', () => {
    const { mic, clicks } = composer();
    const stopGen = vi.fn();
    document.getElementById('stop-generating').addEventListener('click', stopGen);
    press();
    setIcon(mic, 'square');
    press();
    expect(clicks).toHaveBeenCalledTimes(2);
    expect(stopGen).not.toHaveBeenCalled();
  });

  it('does nothing while transcribing', () => {
    const { mic, clicks } = composer();
    press();
    setIcon(mic, 'square');
    press();
    setIcon(mic, 'loader-circle');
    const ev = press();
    expect(clicks).toHaveBeenCalledTimes(2);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('works with Shift too', () => {
    const { clicks } = composer();
    press({ shiftKey: true });
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it('works with Option+Space (macOS swallows Ctrl+Space for input-source switching)', () => {
    const { clicks } = composer();
    const ev = press({ ctrlKey: false, altKey: true });
    expect(clicks).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true); // no non-breaking space typed into the prompt
  });

  it('ignores key repeat, Cmd combos, Ctrl+Option and plain Space', () => {
    const { clicks } = composer();
    press({ repeat: true });
    press({ metaKey: true });
    press({ altKey: true }); // with ctrlKey still true from the default
    press({ ctrlKey: false });
    expect(clicks).not.toHaveBeenCalled();
  });

  it('lets the key through when voice is off (no mic button)', () => {
    document.body.innerHTML = '<textarea></textarea>';
    expect(press().defaultPrevented).toBe(false);
  });
});
