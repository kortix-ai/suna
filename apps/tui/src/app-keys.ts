/**
 * What the app's global key handler does with one key press.
 *
 * It is a pure function so the gating rules — the part that is easy to get
 * wrong and impossible to eyeball — are asserted directly
 * (`app-keys.test.ts`), not inferred from a rendered frame.
 *
 * ── The rule that shapes everything here ──
 * `useKeyboard` subscribes at the GLOBAL level and OpenTUI dispatches global
 * listeners BEFORE the focused renderable
 * (`docs/opentui-api-reference.md` §2.4). So every binding the app claims is a
 * key TAKEN AWAY from whatever has focus. Three consequences:
 *
 *  1. A single-character binding (`?`) must stand down while a text input has
 *     focus, or it is a character the user cannot type.
 *  2. While the terminal panel has focus the app keeps exactly
 *     `TERMINAL_RESERVED_CHORDS` — Tab, Shift+Tab, Alt+T, Ctrl+Q — and nothing
 *     else. `Ctrl+C` is the shell's; a shell without `Ctrl+C` is not a shell.
 *  3. An open overlay owns the keyboard, except for quit: `?` must not be a
 *     room with no door. A suspended renderer (attach mode) owns it outright,
 *     because nothing of ours is on screen and `Ctrl+C` twice is how opencode
 *     itself is left.
 */

import type { KeyEvent } from '@opentui/core';

import { isReservedWhileTerminalFocused } from './features/terminal/keys.ts';
import { matchesBinding } from './keymap.ts';

/** The screens the app routes between. Overlays are separate state. */
export type Route = 'session' | 'files' | 'review' | 'apps' | 'customize' | 'account';

/** The regions Tab cycles through. */
export type Focus = 'sidebar' | 'transcript' | 'composer' | 'terminal' | 'screen';

/** The one overlay slot's contents. */
export type Overlay = 'help' | 'switcher' | null;

/** Route chords, in the order the handler tests them. */
export const SCREEN_BINDINGS: readonly (readonly [string, Route])[] = [
  ['screen.files', 'files'],
  ['screen.review', 'review'],
  ['screen.apps', 'apps'],
  ['screen.customize', 'customize'],
  ['screen.account', 'account'],
] as const;

export type AppKeyAction =
  | { kind: 'quit' }
  /** First Ctrl+C: ask before leaving. */
  | { kind: 'arm-quit' }
  | { kind: 'focus'; step: 1 | -1 }
  | { kind: 'toggle-terminal' }
  | { kind: 'overlay'; overlay: Exclude<Overlay, null> }
  | { kind: 'new-session' }
  | { kind: 'attach' }
  | { kind: 'switch-host' }
  | { kind: 'route'; route: Route }
  /** Leave the current screen for the session. */
  | { kind: 'back' }
  /** Esc in the transcript hands the keyboard back to the composer. */
  | { kind: 'focus-composer' };

export interface AppKeyState {
  focus: Focus;
  route: Route;
  overlay: Overlay;
  /** A Ctrl+C is already pending. */
  quitArmed: boolean;
  /** The renderer is suspended for attach mode. */
  attaching: boolean;
}

/** True when the app must not steal this key from the region that has focus. */
export function globalKeyBlocked(focus: Focus): boolean {
  // The composer is a text field: `?` is a character and Esc clears the draft.
  // The terminal is a shell: everything not reserved is the shell's.
  return focus === 'composer' || focus === 'terminal';
}

/**
 * The action for `key`, or null when the app leaves the key alone.
 *
 * A non-null result also means "call `key.preventDefault()`", with one
 * exception the caller applies: quitting does not need it.
 */
export function globalKeyAction(key: KeyEvent, state: AppKeyState): AppKeyAction | null {
  // Attach mode is opaque: opencode has the terminal, and `Ctrl+C` twice is
  // how the user leaves IT. An overlay is not — it is ours, it is on screen,
  // and a user who opens `?` and reaches for `Ctrl+C` must not be trapped.
  if (state.attaching) return null;
  if (state.overlay) {
    if (!matchesBinding(key, 'quit')) return null;
    return key.name === 'q' || state.quitArmed ? { kind: 'quit' } : { kind: 'arm-quit' };
  }

  const terminalFocused = state.focus === 'terminal';
  if (terminalFocused && !isReservedWhileTerminalFocused(key)) return null;

  if (matchesBinding(key, 'quit')) {
    // Ctrl+Q leaves at once. Ctrl+C asks first — and inside the terminal it is
    // not ours at all, so it never even arms.
    if (key.name === 'q' || state.quitArmed) return { kind: 'quit' };
    if (terminalFocused) return null;
    return { kind: 'arm-quit' };
  }

  if (matchesBinding(key, 'focus.next')) return { kind: 'focus', step: 1 };
  if (matchesBinding(key, 'focus.prev')) return { kind: 'focus', step: -1 };
  if (matchesBinding(key, 'panel.terminal')) return { kind: 'toggle-terminal' };
  // Nothing below this line is reserved, so the terminal keeps the rest.
  if (terminalFocused) return null;

  if (matchesBinding(key, 'help')) {
    return globalKeyBlocked(state.focus) ? null : { kind: 'overlay', overlay: 'help' };
  }
  if (matchesBinding(key, 'switcher')) return { kind: 'overlay', overlay: 'switcher' };
  if (matchesBinding(key, 'session.new')) return { kind: 'new-session' };
  if (matchesBinding(key, 'attach')) return { kind: 'attach' };
  if (matchesBinding(key, 'hosts')) return { kind: 'switch-host' };

  for (const [id, route] of SCREEN_BINDINGS) {
    if (matchesBinding(key, id)) return { kind: 'route', route };
  }

  if (matchesBinding(key, 'back')) {
    if (state.route !== 'session') return { kind: 'back' };
    if (globalKeyBlocked(state.focus)) return null;
    if (state.focus === 'transcript') return { kind: 'focus-composer' };
  }
  return null;
}
