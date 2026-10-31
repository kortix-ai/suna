/**
 * The Spaces screen's key table. Scope `'spaces'`, widened locally because
 * `KeyScope` in `src/keymap.ts` has no such member yet. The integrator splices
 * `SPACES_KEYS` into the global table.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

export type SpacesKeyScope = KeyScope | 'spaces';

export type SpacesBinding = Omit<Binding, 'scope'> & { scope: SpacesKeyScope };

const bind = (id: string, chords: Binding['chords'], description: string): SpacesBinding => ({
  id: `spaces.${id}`,
  scope: 'spaces',
  chords,
  description,
});

export const SPACES_KEYS: readonly SpacesBinding[] = [
  bind('down', [{ key: 'j' }, { key: 'down' }], 'Move down.'),
  bind('up', [{ key: 'k' }, { key: 'up' }], 'Move up.'),
  bind('first', [{ key: 'g' }], 'Go to the first row.'),
  bind('last', [{ key: 'G' }], 'Go to the last row.'),
  bind('open', [{ key: 'return' }], 'Open the space, or open the thread as a session.'),
  bind('new', [{ key: 'n' }], 'Start a new thread in the open space.'),
  bind('browser', [{ key: 'o' }], 'Open the space in the browser.'),
  bind('refresh', [{ key: 'r' }], 'Reload the list.'),
  bind('back', [{ key: 'escape' }], 'Leave the threads, or leave the screen.'),
] as const;

/** True when `event` matches any chord of the Spaces binding with this id. */
export function matchesSpacesBinding(event: KeyEvent, id: string): boolean {
  const binding = SPACES_KEYS.find((entry) => entry.id === `spaces.${id}`);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
