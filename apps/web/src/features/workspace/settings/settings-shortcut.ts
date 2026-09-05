/**
 * Mod+, — the keystroke that opens the Settings overlay.
 *
 * Pure and dependency-free on purpose: `preferences-tab.tsx` prints the keycap
 * and is rendered under `renderToStaticMarkup` with no React harness, so the
 * constant it reads must not drag the sidebar's module graph in behind it. The
 * hook that BINDS the keystroke is the separate `use-settings-shortcut.ts`.
 *
 * **Why it lives here and not in the sidebar.** It used to be
 * `useSettingsKeyboardShortcut` in `project-sidebar/project-settings-nav.tsx`,
 * mounted by `ProjectSidebar`, because a sidebar row printed the keycap. That
 * row is gone (Jay, 2026-08-17) and the sidebar is not what the keystroke
 * opens — `SettingsPanel` is. Keeping the handler next to the panel means the
 * shortcut exists exactly where a renderer exists to answer it: `ProjectShell`
 * and the standalone `/settings` route both mount `SettingsPanel`, and nothing
 * else can be opened by poking the store (see `user-menu.tsx`'s note on the
 * two mounts).
 */

/** The keycap this shortcut prints, minus the modifier — the Preferences list
 *  and the workspace switcher's Settings row both build their label from it,
 *  so the advertised key cannot drift from the one that is handled. */
export const SETTINGS_SHORTCUT_KEY = ',';

/**
 * How the shortcut is PRINTED, which is not how it is matched: the handler
 * takes Cmd or Ctrl on every platform, while a keycap can only show one, so it
 * shows the one that platform's users press. `⌘,` with no separator on macOS
 * and `Ctrl+,` elsewhere — each platform's own menu convention.
 *
 * Built from `SETTINGS_SHORTCUT_KEY`, so the label and the match cannot drift.
 *
 * Client-only by construction: the one caller renders inside a dropdown that
 * portals on open, so this never runs during SSR and cannot produce a
 * hydration mismatch.
 */
export function settingsShortcutLabel(): string {
  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  return isMac ? `⌘${SETTINGS_SHORTCUT_KEY}` : `Ctrl+${SETTINGS_SHORTCUT_KEY}`;
}

/** The fields of `KeyboardEvent` the match reads. Declared structurally so the
 *  predicate is testable with a plain object — no DOM required. */
export interface SettingsShortcutEvent {
  key: string;
  /** Physical key, layout-independent. */
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}

/**
 * Does this keystroke mean "open Settings"?
 *
 * - **Cmd OR Ctrl**, deliberately both. Every platform's Preferences keystroke
 *   is its own modifier + comma, and this app is browser, desktop and Windows
 *   at once, so accepting either is one shortcut, not two. It does NOT follow
 *   the `tabSwitchModifier` preference: that preference exists because tab
 *   switching collides with browser chrome, and `,` collides with nothing.
 * - **`key` or `code`.** On a US layout `,` is `code: 'Comma'`. On AZERTY the
 *   physical Comma key types `;` and `,` sits on `code: 'KeyM'` — matching
 *   either means both keyboards get the shortcut their fingers expect.
 * - **No Shift, no Alt.** Cmd+Shift+, and Cmd+Alt+, are free for other things,
 *   and swallowing them here would break whatever claims them later.
 * - **`repeat` rejected.** Holding the keys re-fires keydown ~30x/second, and
 *   each one would re-run `openSettings()` and reset `membersTab`.
 * - **`defaultPrevented` rejected.** A nearer handler already consumed it.
 */
export function matchesSettingsShortcut(event: SettingsShortcutEvent): boolean {
  if (event.defaultPrevented || event.repeat) return false;
  if (event.shiftKey || event.altKey) return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return event.key === SETTINGS_SHORTCUT_KEY || event.code === 'Comma';
}
