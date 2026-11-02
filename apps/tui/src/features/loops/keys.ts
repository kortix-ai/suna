/**
 * The Loops screen's key table. Scope `'loops'`, widened locally because
 * `KeyScope` in `src/keymap.ts` has no such member yet. The integrator splices
 * `LOOPS_KEYS` into the global table.
 *
 * Text typed into the create form is not a binding: it is read by `editText`.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

export type LoopsKeyScope = KeyScope | 'loops';

export type LoopsBinding = Omit<Binding, 'scope'> & { scope: LoopsKeyScope };

const bind = (id: string, chords: Binding['chords'], description: string): LoopsBinding => ({
  id: `loops.${id}`,
  scope: 'loops',
  chords,
  description,
});

export const LOOPS_KEYS: readonly LoopsBinding[] = [
  bind('down', [{ key: 'j' }, { key: 'down' }], 'Move down.'),
  bind('up', [{ key: 'k' }, { key: 'up' }], 'Move up.'),
  bind('first', [{ key: 'g' }], 'Go to the first loop.'),
  bind('last', [{ key: 'G' }], 'Go to the last loop.'),
  bind('details', [{ key: 'return' }], 'Show the full prompt and the last run of the loop.'),
  bind('new', [{ key: 'n' }], 'Create a loop in this session.'),
  bind('toggle', [{ key: 'space' }], 'Pause or resume the selected loop.'),
  bind('run', [{ key: 'x' }], 'Run the selected loop now. The schedule does not move.'),
  bind('delete', [{ key: 'd' }], 'Delete the selected loop (asks first).'),
  bind('refresh', [{ key: 'r' }], 'Reload the loops.'),
  bind('confirm', [{ key: 'y' }], 'Confirm the delete.'),
  bind('deny', [{ key: 'n' }], 'Decline the delete.'),
  bind('field', [{ key: 'tab' }], 'In the create form: switch between prompt and schedule.'),
  bind('back', [{ key: 'escape' }], 'Close the form or details, or leave the screen.'),
] as const;

/** True when `event` matches any chord of the Loops binding with this id. */
export function matchesLoopsBinding(event: KeyEvent, id: string): boolean {
  const binding = LOOPS_KEYS.find((entry) => entry.id === `loops.${id}`);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}

/** The fields of a key event `editText` reads. */
export interface TextKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  option?: boolean;
  meta?: boolean;
}

/**
 * Apply one key press to a single-line text value. Backspace deletes the last
 * character; a printable character with no modifier is appended. Returns
 * `null` for any other key.
 */
export function editText(value: string, key: TextKey): string | null {
  if (key.name === 'backspace') return value.slice(0, -1);
  if (key.ctrl || key.option || key.meta) return null;
  const text = key.sequence;
  if (!text || text.length !== 1) return null;
  const code = text.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return null;
  return value + text;
}
