/**
 * Transcript key table.
 *
 * Same shape as `src/keymap.ts` (`Binding[]`, one `Chord[]` per binding) so the
 * help overlay can render it unchanged once the integrator merges it into
 * `KEYMAP`. Two ids — `transcript.bottom` and `transcript.older` — already
 * exist in the global table with exactly these chords; they are repeated here
 * with the same id so there is one id per concept, and the merge replaces
 * rather than duplicates them.
 *
 * `matchesBinding` from `src/keymap.ts` only looks in the global table, so
 * this file ships its own lookup over its own table.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, matchesChord } from '../../../keymap.ts';

/** Every id in `TRANSCRIPT_KEYS`. Declared, not inferred: the table is typed
 *  `readonly Binding[]`, which widens `id` to `string`. */
export type TranscriptBindingId =
  | 'transcript.down'
  | 'transcript.up'
  | 'transcript.pageDown'
  | 'transcript.older'
  | 'transcript.top'
  | 'transcript.bottom'
  | 'transcript.rowNext'
  | 'transcript.rowPrev'
  | 'transcript.toggle';

export const TRANSCRIPT_KEYS: readonly Binding[] = [
  {
    id: 'transcript.down',
    scope: 'transcript',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Scroll down one line.',
  },
  {
    id: 'transcript.up',
    scope: 'transcript',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Scroll up one line.',
  },
  {
    id: 'transcript.pageDown',
    scope: 'transcript',
    chords: [{ key: 'pagedown' }],
    description: 'Scroll down one screen.',
  },
  {
    id: 'transcript.older',
    scope: 'transcript',
    chords: [{ key: 'pageup' }],
    description: 'Scroll up one screen. At the top, load older turns.',
  },
  {
    id: 'transcript.top',
    scope: 'transcript',
    chords: [{ key: 'g' }],
    description: 'Jump to the oldest turn.',
  },
  {
    id: 'transcript.bottom',
    scope: 'transcript',
    chords: [{ key: 'G' }],
    description: 'Jump to the newest turn and re-lock autoscroll.',
  },
  {
    id: 'transcript.rowNext',
    scope: 'transcript',
    chords: [{ key: 'J' }],
    description: 'Move the cursor to the next collapsible row.',
  },
  {
    id: 'transcript.rowPrev',
    scope: 'transcript',
    chords: [{ key: 'K' }],
    description: 'Move the cursor to the previous collapsible row.',
  },
  {
    id: 'transcript.toggle',
    scope: 'transcript',
    chords: [{ key: 'return' }, { key: 'space' }],
    description: 'Expand or collapse the row under the cursor.',
  },
];

/** True when `event` matches the transcript binding with this id. */
export function matchesTranscriptBinding(event: KeyEvent, id: TranscriptBindingId): boolean {
  const binding = TRANSCRIPT_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
