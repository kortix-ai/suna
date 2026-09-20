/**
 * `ACCOUNT_KEYS` → a key matcher.
 *
 * Split from `keys.ts` for the same reason as
 * `features/login/match.ts` — see that file's header for the import cycle it
 * avoids and for the one-line fix that belongs in `src/keymap.ts`.
 */

import type { KeyEvent } from '@opentui/core';

import { matchesChord } from '../../keymap.ts';
import { ACCOUNT_KEYS } from './keys.ts';

/** True when `event` matches any chord of the account binding with this id. */
export function matchesAccountBinding(event: KeyEvent, id: string): boolean {
  const binding = ACCOUNT_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
