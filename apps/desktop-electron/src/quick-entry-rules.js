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

/**
 * Centered at the bottom of the display, its bottom edge a twentieth of the way up.
 * The bar grows upward as the prompt grows, so the bottom stays put.
 */
function quickEntryBounds(workArea, width, height) {
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - height - workArea.height / 20),
    width,
    height,
  };
}

/** At most this many files ride with one prompt, each at most this large. */
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * The files the bar hands over with a prompt: screenshots and picked files as
 * `{ name, type, bytes }`. Anything malformed, empty or too large is dropped
 * here, at the trust boundary between the bar page and the app.
 */
function normalizeAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .filter((file) => file?.bytes instanceof Uint8Array && file.bytes.byteLength > 0 && file.bytes.byteLength <= MAX_ATTACHMENT_BYTES)
    .slice(0, MAX_ATTACHMENTS)
    .map((file) => ({
      name: label(file.name, 'attachment').replace(/[\\/]/g, '_'),
      type: typeof file.type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : 'application/octet-stream',
      bytes: file.bytes,
    }));
}

/** "Screenshot 2026-10-12 at 15.04.31.png", the name macOS gives its own. */
function screenshotName(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `Screenshot ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} at ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}.png`;
}

/** The pending prompt while it is fresh, else null. */
function freshPrompt(pending, now) {
  if (!pending || now - pending.at > PENDING_TTL_MS) return null;
  return pending;
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
 * activity first: `{ id, title, status, lastActiveAt }` (`lastActiveAt` an ISO time).
 */
function normalizeTarget(target) {
  const projectId = label(target?.projectId, '');
  if (!projectId) return null;
  const sessions = (Array.isArray(target.sessions) ? target.sessions : [])
    .map((session) => {
      const id = label(session?.id, '');
      if (!id) return null;
      const status = Object.hasOwn(SESSION_STATUS_TEXT, session.status) ? session.status : 'stopped';
      const lastActiveAt = Date.parse(session.lastActiveAt);
      return {
        id,
        title: label(session.title, 'Untitled session'),
        status,
        ...(Number.isFinite(lastActiveAt) ? { lastActiveAt } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, RECENT_SESSIONS);
  return { projectId, name: label(target.name, null), sessions, composer: normalizeComposer(target.composer) };
}

/**
 * A new session's agent, as the web app's composer resolves it for this
 * project: `{ agents: [{ id, label }], agent }`. Null while the web app has
 * not sent it. The model and effort stay the composer's own.
 */
function normalizeComposer(composer) {
  if (!composer || typeof composer !== 'object') return null;
  const agents = (Array.isArray(composer.agents) ? composer.agents : [])
    .map((agent) => {
      const id = label(agent?.id, '');
      return id ? { id, label: label(agent.label, id) } : null;
    })
    .filter(Boolean)
    .slice(0, 300);
  const agent = agents.some((item) => item.id === composer.agent) ? composer.agent : null;
  return { agents, agent };
}

/** The bar's agent label; null hides the button. */
function composerLabels(composer) {
  if (!composer) return null;
  return { agent: composer.agents.find((item) => item.id === composer.agent)?.label ?? null };
}

/** The agent menu's rows: `{ value, label, checked }`. `value` is the agent name the web app applies. */
function composerMenuItems(composer, kind) {
  if (!composer || kind !== 'agent') return [];
  return composer.agents.map((agent) => ({ value: agent.id, label: agent.label, checked: agent.id === composer.agent }));
}

/** The session a prompt goes to: the picked one while the web app still lists it, else null (a new session). */
function pickedSession(target, sessionId) {
  return target?.sessions.find((session) => session.id === sessionId) ?? null;
}

/** A pick is kept for the next open while its session is live; else the bar opens on a new session. */
const LIVE_STATUSES = new Set(['running', 'starting', 'needs-you']);
function keptPick(target, sessionId) {
  const session = pickedSession(target, sessionId);
  return session && LIVE_STATUSES.has(session.status) ? session.id : null;
}

/** "just now", "5 min ago", "3 h ago", "Yesterday", else "Oct 9". */
function relativeTime(ms, now) {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 48 * 60) return 'Yesterday';
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(ms);
}

/**
 * The picker menu, top to bottom: a new session in the project, then the
 * recent sessions. Exactly one item is checked: the picked session while it is
 * still listed, else the new session. A session's line under its title is its
 * status and when it was last active, which also tells apart two sessions whose
 * titles never landed ("New session").
 */
function pickerItems(target, sessionId, now = Date.now()) {
  const picked = pickedSession(target, sessionId);
  return [
    { sessionId: null, label: 'New session', checked: !picked },
    ...(target?.sessions ?? []).map((session) => ({
      sessionId: session.id,
      label: session.title,
      status: session.status,
      statusText: [SESSION_STATUS_TEXT[session.status], session.lastActiveAt && relativeTime(session.lastActiveAt, now)]
        .filter(Boolean)
        .join(' · '),
      checked: picked?.id === session.id,
    })),
  ];
}

module.exports = {
  DEFAULT_SHORTCUT,
  PENDING_TTL_MS,
  SHORTCUTS,
  RECENT_SESSIONS,
  composerLabels,
  composerMenuItems,
  freshPrompt,
  normalizeTarget,
  keptPick,
  pickedSession,
  pickerItems,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  normalizeAttachments,
  quickEntryBounds,
  relativeTime,
  screenshotName,
  resolveShortcut,
  shortcutLabel,
};
