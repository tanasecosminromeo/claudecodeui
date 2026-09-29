/* cloudcli-ui-cleanup: Ctrl+Space or Option+Space toggles voice input (the composer mic button).
   Upstream has no shortcut for it, and the button has no label, so it is found
   by its lucide icon: Mic when idle, Square while recording, a loader while
   transcribing. Option+Space is for macOS, which swallows Ctrl+Space (and
   Ctrl+Shift+Space) for input-source switching: the page only ever sees the
   Ctrl keydown. Alt+Space is not the Linux key because window managers take it.
   Failure mode if upstream markup changes: the key does nothing and passes
   through. */
(() => {
  'use strict';
  let button = null; // the mic button this shortcut last started

  const shows = (el, icon) => !!el.querySelector(`svg.lucide-${icon}`);

  function findMic() {
    const icon = document.querySelector('button svg.lucide-mic');
    return icon ? icon.closest('button') : null;
  }

  // Clicking moves focus to the button, where the next Enter would press it
  // again and start a new recording. Put focus back where the user was typing.
  function click(el) {
    const prev = document.activeElement;
    el.click();
    if (prev && prev !== document.body && prev.isConnected) prev.focus();
  }

  function onKeyDown(event) {
    // Exactly one of Ctrl or Option/Alt; Shift is allowed, Cmd is not.
    if (event.code !== 'Space' || event.ctrlKey === event.altKey || event.metaKey || event.repeat) return;

    if (button && button.isConnected) {
      // Only ever stop the button we started: stop-generation is also a Square.
      if (shows(button, 'square')) {
        event.preventDefault();
        click(button);
        return;
      }
      if (!shows(button, 'mic')) { // transcribing
        event.preventDefault();
        return;
      }
    }

    const mic = findMic();
    if (!mic) return; // voice input is off: leave the key alone
    event.preventDefault();
    button = mic;
    click(mic);
  }

  // Capture phase, so the composer's own key handlers never see it.
  window.addEventListener('keydown', onKeyDown, true);
})();
