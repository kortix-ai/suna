/**
 * The sidebar's key table.
 *
 * Declared in the same `Binding` shape as `src/keymap.ts` and scoped
 * `'sidebar'`, so the integrator can splice this array into the global KEYMAP
 * and the help overlay (`?`) renders these rows with no extra work. Until then
 * the sidebar matches against its own table with `matchesSidebarBinding` —
 * `matchesBinding` in `keymap.ts` only ever looks inside KEYMAP.
 *
 * A binding that is not in this table does not exist: the sidebar never
 * compares `key.name` inline.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, matchesChord } from '../../keymap.ts';

export const SIDEBAR_KEYS: readonly Binding[] = [
  {
    id: 'sidebar.down',
    scope: 'sidebar',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down.',
  },
  {
    id: 'sidebar.up',
    scope: 'sidebar',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up.',
  },
  {
    id: 'sidebar.first',
    scope: 'sidebar',
    chords: [{ key: 'g' }],
    description: 'Go to the first row.',
  },
  {
    id: 'sidebar.last',
    scope: 'sidebar',
    chords: [{ key: 'G' }],
    description: 'Go to the last row.',
  },
  {
    id: 'sidebar.open',
    scope: 'sidebar',
    chords: [{ key: 'return' }],
    description: 'Open the row: the session, the picker, or the screen.',
  },
  {
    id: 'sidebar.filter',
    scope: 'sidebar',
    chords: [{ key: '/' }],
    description: 'Filter the session list. Esc clears it.',
  },
  {
    id: 'sidebar.rename',
    scope: 'sidebar',
    chords: [{ key: 'r' }],
    description: 'Rename the selected session.',
  },
  {
    id: 'sidebar.delete',
    scope: 'sidebar',
    chords: [{ key: 'd' }],
    description: 'Delete the selected session (asks first).',
  },
  {
    id: 'sidebar.attach',
    scope: 'sidebar',
    chords: [{ key: 'a' }],
    description: 'Attach the selected session in the stock opencode TUI.',
  },
  {
    id: 'sidebar.new',
    scope: 'sidebar',
    chords: [{ key: 'n' }],
    description: 'Create a session in this project.',
  },
  {
    id: 'sidebar.confirm',
    scope: 'sidebar',
    chords: [{ key: 'y' }, { key: 'return' }],
    description: 'Confirm the delete.',
  },
  {
    id: 'sidebar.deny',
    scope: 'sidebar',
    chords: [{ key: 'n' }],
    description: 'Decline the delete.',
  },
  {
    id: 'sidebar.cancel',
    scope: 'sidebar',
    chords: [{ key: 'escape' }],
    description: 'Cancel the input, the confirm, or the filter.',
  },
] as const;

/** True when `event` matches any chord of the sidebar binding with this id. */
export function matchesSidebarBinding(event: KeyEvent, id: string): boolean {
  const binding = SIDEBAR_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
