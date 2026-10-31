/**
 * The Goals screen's key table.
 *
 * Same `Binding` shape as `src/keymap.ts`, so the integrator can splice this
 * array into the global KEYMAP and the help overlay (`?`) renders these rows.
 * `KeyScope` has no `'goals'` member yet and widening a shared file is the
 * integrator's call, so the scope is widened locally (`ScreenBinding`).
 *
 * A binding that is not in this table does not exist: the Goals screen never
 * compares `key.name` inline.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

/** `KeyScope` plus the scope this feature owns. Local until `keymap.ts` widens. */
export type ScreenScope = KeyScope | 'goals';

/** A `Binding` whose scope may be `'goals'`. */
export interface ScreenBinding extends Omit<Binding, 'scope'> {
  scope: ScreenScope;
}

export const GOALS_KEYS: readonly ScreenBinding[] = [
  {
    id: 'goals.down',
    scope: 'goals',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down.',
  },
  {
    id: 'goals.up',
    scope: 'goals',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up.',
  },
  { id: 'goals.first', scope: 'goals', chords: [{ key: 'g' }], description: 'Go to the top.' },
  { id: 'goals.last', scope: 'goals', chords: [{ key: 'G' }], description: 'Go to the bottom.' },
  {
    id: 'goals.open',
    scope: 'goals',
    chords: [{ key: 'return' }],
    description: 'Open the goal, or the linked session under the cursor.',
  },
  {
    id: 'goals.new',
    scope: 'goals',
    chords: [{ key: 'n' }],
    description: 'Start a goal: describe the outcome, a new session writes it.',
  },
  {
    id: 'goals.reply',
    scope: 'goals',
    chords: [{ key: 'a' }],
    description: "Answer the goal's question (wakes its owner session).",
  },
  {
    id: 'goals.stop',
    scope: 'goals',
    chords: [{ key: 's' }],
    description: 'Stop the goal (asks first).',
  },
  {
    id: 'goals.web',
    scope: 'goals',
    chords: [{ key: 'o' }],
    description: 'Open the goal in the browser.',
  },
  { id: 'goals.refresh', scope: 'goals', chords: [{ key: 'r' }], description: 'Reload the goals.' },
  {
    id: 'goals.confirm',
    scope: 'goals',
    chords: [{ key: 'y' }, { key: 'return' }],
    description: 'Confirm.',
  },
  { id: 'goals.deny', scope: 'goals', chords: [{ key: 'n' }], description: 'Decline.' },
  {
    id: 'goals.back',
    scope: 'goals',
    chords: [{ key: 'escape' }],
    description: 'Leave the detail, the input, or the screen.',
  },
] as const;

/** True when `event` matches any chord of the Goals binding with this id. */
export function matchesGoalsBinding(event: KeyEvent, id: string): boolean {
  const binding = GOALS_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
