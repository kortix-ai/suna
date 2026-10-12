// Quick Entry rules: the shortcut choices, their menu labels, where the bar
// opens, and how long a typed prompt waits for the app window. Pure, so
// quick-entry-rules.test.js covers them without Electron.

/**
 * The shortcuts the menu offers. ⌥Space is what Claude and ChatGPT default to,
 * so it is a choice and not the default: a second app on the same key makes
 * one of the two silently lose it.
 */
const SHORTCUTS = ['CommandOrControl+Shift+Space', 'Alt+Space', 'Alt+Shift+Space'];
const DEFAULT_SHORTCUT = SHORTCUTS[0];

/**
 * A prompt the app window has not taken after this long is dropped. It waits
 * through a cold window load or a sign-in; an agent must never act on a prompt
 * typed long before.
 */
const PENDING_TTL_MS = 10 * 60_000;

/**
 * The shortcut to register for a saved `quick_entry.json` value.
 * `null` is Off. A missing or unknown value is the default.
 */
function resolveShortcut(saved) {
  if (saved === null) return null;
  return SHORTCUTS.includes(saved) ? saved : DEFAULT_SHORTCUT;
}

/** "Command + Shift + Space" on macOS, "Ctrl + Shift + Space" elsewhere. */
function shortcutLabel(accelerator, platform) {
  const mac = platform === 'darwin';
  const names = { CommandOrControl: mac ? 'Command' : 'Ctrl', Alt: mac ? 'Option' : 'Alt' };
  return accelerator
    .split('+')
    .map((key) => names[key] ?? key)
    .join(' + ');
}

/** Centered on the display, its top edge a quarter of the way down, like Spotlight. */
function quickEntryBounds(workArea, width, height) {
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height / 4),
    width,
    height,
  };
}

/** The pending prompt's text while it is fresh, else null. */
function freshPrompt(pending, now) {
  if (!pending || now - pending.at > PENDING_TTL_MS) return null;
  return pending.text;
}

/** `{ projectId, name }` from the web app, or null for anything else. */
function normalizeTarget(target) {
  const projectId = typeof target?.projectId === 'string' ? target.projectId.slice(0, 200) : '';
  if (!projectId) return null;
  const name = typeof target.name === 'string' && target.name.trim() ? target.name.trim().slice(0, 200) : null;
  return { projectId, name };
}

module.exports = {
  DEFAULT_SHORTCUT,
  PENDING_TTL_MS,
  SHORTCUTS,
  freshPrompt,
  normalizeTarget,
  quickEntryBounds,
  resolveShortcut,
  shortcutLabel,
};
