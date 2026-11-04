/**
 * The Inbox screen's key table.
 *
 * Same `Binding` shape as `src/keymap.ts`; the scope is widened locally
 * (`ScreenBinding`) because `KeyScope` has no `'inbox'` member and widening a
 * shared file is the integrator's call. A binding that is not in this table
 * does not exist.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

/** `KeyScope` plus the scope this feature owns. Local until `keymap.ts` widens. */
export type ScreenScope = KeyScope | 'inbox';

/** A `Binding` whose scope may be `'inbox'`. */
export interface ScreenBinding extends Omit<Binding, 'scope'> {
  scope: ScreenScope;
}

export const INBOX_KEYS: readonly ScreenBinding[] = [
  {
    id: 'inbox.down',
    scope: 'inbox',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down.',
  },
  {
    id: 'inbox.up',
    scope: 'inbox',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up.',
  },
  { id: 'inbox.first', scope: 'inbox', chords: [{ key: 'g' }], description: 'Go to the newest.' },
  { id: 'inbox.last', scope: 'inbox', chords: [{ key: 'G' }], description: 'Go to the oldest.' },
  {
    id: 'inbox.open',
    scope: 'inbox',
    chords: [{ key: 'return' }],
    description: 'Mark read and open it: the session, or the web page.',
  },
  {
    id: 'inbox.read',
    scope: 'inbox',
    chords: [{ key: 'm' }],
    description: 'Mark the selected notification read.',
  },
  {
    id: 'inbox.readAll',
    scope: 'inbox',
    chords: [{ key: 'a' }],
    description: 'Mark every notification read.',
  },
  {
    id: 'inbox.filter',
    scope: 'inbox',
    chords: [{ key: 'f' }],
    description: 'Cycle the filter: all, unread, needs you.',
  },
  {
    id: 'inbox.web',
    scope: 'inbox',
    chords: [{ key: 'o' }],
    description: 'Open the notification in the browser.',
  },
  { id: 'inbox.refresh', scope: 'inbox', chords: [{ key: 'r' }], description: 'Reload the inbox.' },
  {
    id: 'inbox.back',
    scope: 'inbox',
    chords: [{ key: 'escape' }],
    description: 'Leave the inbox.',
  },
] as const;

/** True when `event` matches any chord of the Inbox binding with this id. */
export function matchesInboxBinding(event: KeyEvent, id: string): boolean {
  const binding = INBOX_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
