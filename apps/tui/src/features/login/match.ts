/**
 * `LOGIN_KEYS` → a key matcher.
 *
 * Separate from `keys.ts` ON PURPOSE. `src/keymap.ts` imports every feature's
 * key TABLE at module scope (`FEATURE_TABLES`), so a feature `keys.ts` that
 * also imports `matchesChord` back from `keymap.ts` closes an import cycle. The
 * cycle is harmless when `keymap.ts` is entered first and fatal when the
 * feature's own file is: `keymap.ts`'s top-level `FEATURE_TABLES` then reads
 * `LOGIN_KEYS` while `keys.ts` is still mid-evaluation and Bun throws
 * `ReferenceError: Cannot access 'LOGIN_KEYS' before initialization`.
 * Reproduced with `bun test src/features/login/login-screen.test.tsx`.
 *
 * Keeping `keys.ts` a LEAF (data plus a type-only import) removes this feature
 * from that cycle. The general fix belongs in `keymap.ts` — build
 * `FEATURE_TABLES` inside `allBindings()` instead of at module scope — and is
 * the integrator's call; every other feature `keys.ts` has the same hazard.
 */

import type { KeyEvent } from '@opentui/core';

import { matchesChord } from '../../keymap.ts';
import { LOGIN_KEYS } from './keys.ts';

/** True when `event` matches any chord of the login binding with this id. */
export function matchesLoginBinding(event: KeyEvent, id: string): boolean {
  const binding = LOGIN_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
