/**
 * The Drive screen's key table.
 *
 * Same `Binding` shape as `src/keymap.ts`, so the integrator can splice this
 * array into the global KEYMAP and the help overlay (`?`) renders these rows
 * with no extra work. `KeyScope` in `keymap.ts` has no `'drive'` member yet and
 * widening a shared file is the integrator's call, so the scope is widened
 * locally instead (`DriveBinding`).
 *
 * A binding that is not in this table does not exist: the Drive screen never
 * compares `key.name` inline.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

/** `KeyScope` plus the scope this feature owns. Local until `keymap.ts` widens. */
export type DriveScope = KeyScope | 'drive';

/** A `Binding` whose scope may be `'drive'`. */
export interface DriveBinding extends Omit<Binding, 'scope'> {
  scope: DriveScope;
}

export const DRIVE_KEYS: readonly DriveBinding[] = [
  {
    id: 'drive.down',
    scope: 'drive',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down.',
  },
  {
    id: 'drive.up',
    scope: 'drive',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up.',
  },
  { id: 'drive.first', scope: 'drive', chords: [{ key: 'g' }], description: 'Go to the first row.' },
  { id: 'drive.last', scope: 'drive', chords: [{ key: 'G' }], description: 'Go to the last row.' },
  {
    id: 'drive.open',
    scope: 'drive',
    chords: [{ key: 'return' }],
    description: 'Open the place or folder, or preview the file.',
  },
  {
    id: 'drive.parent',
    scope: 'drive',
    chords: [{ key: 'backspace' }, { key: 'h' }, { key: 'left' }],
    description: 'Go up one folder. At the top of a place, go back to Places.',
  },
  {
    id: 'drive.filter',
    scope: 'drive',
    chords: [{ key: '/' }],
    description: 'Filter the rows by name. Esc clears it.',
  },
  {
    id: 'drive.newFolder',
    scope: 'drive',
    chords: [{ key: 'n' }],
    description: 'Make a folder here.',
  },
  {
    id: 'drive.move',
    scope: 'drive',
    chords: [{ key: 'm' }],
    description: 'Move or rename the selected row.',
  },
  {
    id: 'drive.delete',
    scope: 'drive',
    chords: [{ key: 'd' }],
    description: 'Delete the selected row (asks first).',
  },
  {
    id: 'drive.upload',
    scope: 'drive',
    chords: [{ key: 'u' }],
    description: 'Upload a file from this computer into this folder.',
  },
  {
    id: 'drive.openWeb',
    scope: 'drive',
    chords: [{ key: 'o' }],
    description: 'Open this folder in the web app.',
  },
  {
    id: 'drive.copy',
    scope: 'drive',
    chords: [{ key: 'y' }],
    description: "Copy the selected row's Drive path.",
  },
  {
    id: 'drive.refresh',
    scope: 'drive',
    chords: [{ key: 'r' }],
    description: 'Reload the folder.',
  },
  {
    id: 'drive.conflicts',
    scope: 'drive',
    chords: [{ key: 'c' }],
    description: 'Show the conflict copies nobody resolved yet.',
  },
  {
    id: 'drive.dismiss',
    scope: 'drive',
    chords: [{ key: 'x' }],
    description: 'Dismiss the selected conflict notice. The copy stays.',
  },
  {
    id: 'drive.viewerDown',
    scope: 'drive',
    chords: [{ key: 'J' }, { key: 'pagedown' }],
    description: 'Scroll the preview down.',
  },
  {
    id: 'drive.viewerUp',
    scope: 'drive',
    chords: [{ key: 'K' }, { key: 'pageup' }],
    description: 'Scroll the preview up.',
  },
  {
    id: 'drive.confirm',
    scope: 'drive',
    chords: [{ key: 'y' }],
    description: 'Confirm.',
  },
  {
    id: 'drive.deny',
    scope: 'drive',
    chords: [{ key: 'n' }, { key: 'return' }],
    description: 'Decline. Decline is the default.',
  },
  {
    id: 'drive.back',
    scope: 'drive',
    chords: [{ key: 'escape' }],
    description: 'Close the input, the preview or the list, or leave the screen.',
  },
] as const;

/** True when `event` matches any chord of the Drive binding with this id. */
export function matchesDriveBinding(event: KeyEvent, id: string): boolean {
  const binding = DRIVE_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
