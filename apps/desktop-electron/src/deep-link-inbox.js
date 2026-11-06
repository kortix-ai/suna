/**
 * One slot for a kortix:// link (auth callback, magic link).
 *
 * States: no window loaded ⇄ window loaded, with at most one pending link.
 *   receive(url)   loaded → deliver now; else hold it (newest wins) and, when
 *                  a window may be opened (app ready, no window, setup done),
 *                  open one.
 *   windowLoaded() first load of a main window → deliver the held link once.
 *   windowClosed() → back to "no window loaded".
 *
 * Before this, a macOS link that arrived with the window closed was stored
 * and only the one-shot cold-start code read it: the sign-in did nothing.
 */
function createDeepLinkInbox({ deliver, canOpenWindow, openWindow }) {
  let pending = null;
  let loaded = false;
  return {
    receive(url) {
      if (loaded) return deliver(url);
      pending = url;
      if (canOpenWindow()) openWindow();
    },
    windowLoaded() {
      loaded = true;
      if (pending === null) return;
      const url = pending;
      pending = null;
      deliver(url);
    },
    windowClosed() {
      loaded = false;
    },
    hasPending() {
      return pending !== null;
    },
  };
}

module.exports = { createDeepLinkInbox };
