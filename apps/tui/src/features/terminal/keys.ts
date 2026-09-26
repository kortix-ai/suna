/**
 * The terminal panel's own bindings (scope `terminal`).
 *
 * The rule that shapes this table: **a focused terminal owns the keyboard.**
 * Every key that is not listed here is encoded and sent to the remote shell,
 * `Ctrl+C` included — a shell without `Ctrl+C` is not a shell. So a panel
 * binding may not be a bare letter: `y` and `x` belong to the shell (`yes`,
 * `xargs`, vim's yank and cut). Every binding here is therefore an `Alt`
 * chord, which no shell reads.
 *
 * Wave 3 folds `TERMINAL_KEYMAP` into `src/keymap.ts`'s single table so the
 * `?` overlay renders it. Until then it matches with the SAME `matchesChord`
 * as every other scope — this file owns rows, never a second matcher.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type Chord, matchesChord } from '../../keymap.ts';

export type TerminalBindingId =
  | 'terminal.copyConnect'
  | 'terminal.close'
  | 'terminal.reconnect'
  | 'terminal.passthrough';

export const TERMINAL_KEYMAP: readonly Binding[] = [
  {
    id: 'terminal.copyConnect',
    scope: 'terminal',
    chords: [{ key: 'y', alt: true }],
    description: 'Copy `kortix sessions connect <id>` to the clipboard.',
  },
  {
    id: 'terminal.close',
    scope: 'terminal',
    chords: [{ key: 'x', alt: true }],
    description: 'Close the terminal panel.',
  },
  {
    id: 'terminal.reconnect',
    scope: 'terminal',
    chords: [{ key: 'return', alt: true }],
    description: 'Reconnect the terminal now.',
  },
  {
    id: 'terminal.passthrough',
    scope: 'terminal',
    chords: [],
    description:
      'Every other key goes to the remote shell, Ctrl+C included. Quit the TUI with Ctrl+Q; ' +
      'Tab and Alt+T still move focus and toggle the panel.',
  },
] as const;

/**
 * The four chords the APP keeps while the terminal is focused. The panel
 * swallows them (`preventDefault`) so the shell never sees them:
 *
 *   Tab / Shift+Tab  cycle focus out of the panel
 *   Alt+T            toggle the panel
 *   Ctrl+Q           quit the TUI
 *
 * `Ctrl+C` is deliberately absent — it is the shell's.
 */
export const TERMINAL_RESERVED_CHORDS: readonly Chord[] = [
  { key: 'tab' },
  { key: 'tab', shift: true },
  { key: 't', alt: true },
  { key: 'q', ctrl: true },
] as const;

/** True when the app, not the shell, owns this key while the panel is focused. */
export function isReservedWhileTerminalFocused(event: KeyEvent): boolean {
  return TERMINAL_RESERVED_CHORDS.some((chord) => matchesChord(event, chord));
}

/** True when `event` is this terminal binding. */
export function matchesTerminalBinding(event: KeyEvent, id: TerminalBindingId): boolean {
  const binding = TERMINAL_KEYMAP.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
