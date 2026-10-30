/**
 * The Rooms screen's key table. Scope `'rooms'`, widened locally because
 * `KeyScope` in `src/keymap.ts` has no such member yet. The integrator splices
 * `ROOMS_KEYS` into the global table.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

export type RoomsKeyScope = KeyScope | 'rooms';

export type RoomsBinding = Omit<Binding, 'scope'> & { scope: RoomsKeyScope };

const bind = (id: string, chords: Binding['chords'], description: string): RoomsBinding => ({
  id: `rooms.${id}`,
  scope: 'rooms',
  chords,
  description,
});

export const ROOMS_KEYS: readonly RoomsBinding[] = [
  bind('down', [{ key: 'j' }, { key: 'down' }], 'Move down. In a conversation: scroll down.'),
  bind('up', [{ key: 'k' }, { key: 'up' }], 'Move up. In a conversation: scroll up.'),
  bind('first', [{ key: 'g' }], 'Go to the first row, or the oldest message.'),
  bind('last', [{ key: 'G' }], 'Go to the last row, or the newest message.'),
  bind('pageDown', [{ key: 'pagedown' }, { key: 'space' }], 'Scroll a page down.'),
  bind('pageUp', [{ key: 'pageup' }], 'Scroll a page up.'),
  bind('open', [{ key: 'return' }], 'Read the conversation, or open the member as a session.'),
  bind('members', [{ key: 'm' }], 'List the members of the open conversation.'),
  bind('browser', [{ key: 'o' }], 'Open the conversation in the browser.'),
  bind('refresh', [{ key: 'r' }], 'Reload the list or the messages.'),
  bind('back', [{ key: 'escape' }], 'Close the members, close the conversation, or leave the screen.'),
] as const;

/** True when `event` matches any chord of the Rooms binding with this id. */
export function matchesRoomsBinding(event: KeyEvent, id: string): boolean {
  const binding = ROOMS_KEYS.find((entry) => entry.id === `rooms.${id}`);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
