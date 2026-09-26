// Window history and shortcuts for the desktop shell. Route rules live in
// nav-rules.js and are shared with main.js's top-frame navigation gate.
//
// The shell has no browser toolbar. A page without an in-page exit — a setup
// step, an error body, a sandbox preview — leaves the user nowhere to click. So
// Back, Forward and Home are shell behaviour, available on every page: the Go
// menu, its platform shortcuts, and the mouse side buttons.
// The web app's own visible Back (`DesktopBackButton`) sits on top of this.
//
// Pure functions only; main.js owns the Electron side effects.

/**
 * nav-rules.test.js checks these prefixes against the web middleware.
 */
const { APP_PATH_PREFIXES, isAppPath } = require('./nav-rules');

/**
 * The history index one Back or Forward step lands on, or -1.
 *
 * Entries the navigation gate would have sent to the system browser are
 * skipped. They can be in the list: `will-navigate` does not run for a server
 * redirect (`/github/setup` → github.com) or for history traversal, so a plain
 * `goBack()` would reload GitHub inside the app window.
 *
 * @param {{ url: string }[]} entries  `navigationHistory.getAllEntries()`
 * @param {number} activeIndex         `navigationHistory.getActiveIndex()`
 * @param {'back' | 'forward'} direction
 * @param {(url: string) => boolean} isInApp
 */
function historyTarget(entries, activeIndex, direction, isInApp) {
  if (activeIndex < 0 || activeIndex >= entries.length) return -1;
  const step = direction === 'back' ? -1 : 1;
  for (let i = activeIndex + step; i >= 0 && i < entries.length; i += step) {
    if (isInApp(entries[i].url)) return i;
  }
  return -1;
}

/**
 * Go menu accelerators. `darwin` follows Safari and Chrome; `other` follows
 * Chrome on Windows and Linux. Cmd+Left is left out on purpose: in a text
 * field it moves the caret to the line start.
 */
const NAVIGATION_SHORTCUTS = {
  darwin: { back: 'Cmd+[', forward: 'Cmd+]', home: 'Cmd+Shift+H' },
  other: { back: 'Alt+Left', forward: 'Alt+Right', home: 'Alt+Home' },
};

module.exports = {
  APP_PATH_PREFIXES,
  NAVIGATION_SHORTCUTS,
  historyTarget,
  isAppPath,
};
