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

/** The picker lists this many of the project's sessions, most recent first. */
const RECENT_SESSIONS = 5;

/** A trimmed, capped string, or `fallback`. Page script must not push unbounded text into the bar. */
const label = (value, fallback) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : fallback);

/**
 * The session list statuses (`sessionListStatus` in @kortix/sdk, the sidebar's
 * dot) and their menu text. `running` means the session's computer is up.
 */
const SESSION_STATUS_TEXT = {
  running: 'Running',
  'needs-you': 'Needs you',
  starting: 'Starting',
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
  legacy: 'Stopped',
};

/**
 * `{ projectId, name, sessions }` from the web app, or null for anything else.
 * `sessions` is the person's most recent sessions in the project, newest
 * activity first: `{ id, title, status }`.
 */
function normalizeTarget(target) {
  const projectId = label(target?.projectId, '');
  if (!projectId) return null;
  const sessions = (Array.isArray(target.sessions) ? target.sessions : [])
    .map((session) => {
      const id = label(session?.id, '');
      if (!id) return null;
      const status = Object.hasOwn(SESSION_STATUS_TEXT, session.status) ? session.status : 'stopped';
      return { id, title: label(session.title, 'Untitled session'), status };
    })
    .filter(Boolean)
    .slice(0, RECENT_SESSIONS);
  return { projectId, name: label(target.name, null), sessions };
}

/** The session a prompt goes to: the picked one while the web app still lists it, else null (a new session). */
function pickedSession(target, sessionId) {
  return target?.sessions.find((session) => session.id === sessionId) ?? null;
}

/**
 * The picker menu, top to bottom: a new session in the project, then the
 * recent sessions. Exactly one item is checked: the picked session while it is
 * still listed, else the new session.
 */
function pickerItems(target, sessionId) {
  const picked = pickedSession(target, sessionId);
  return [
    { sessionId: null, label: target?.name ? `New session in ${target.name}` : 'New session', checked: !picked },
    ...(target?.sessions ?? []).map((session) => ({
      sessionId: session.id,
      label: session.title,
      status: session.status,
      statusText: SESSION_STATUS_TEXT[session.status],
      checked: picked?.id === session.id,
    })),
  ];
}

module.exports = {
  DEFAULT_SHORTCUT,
  PENDING_TTL_MS,
  SHORTCUTS,
  RECENT_SESSIONS,
  freshPrompt,
  normalizeTarget,
  pickedSession,
  pickerItems,
  quickEntryBounds,
  resolveShortcut,
  shortcutLabel,
};
