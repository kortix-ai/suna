/**
 * The Files screen's key table.
 *
 * Same `Binding` shape as `src/keymap.ts`, scoped `'files'`, so the integrator
 * splices this array into the global KEYMAP and the help overlay (`?`) renders
 * these rows with no extra work. `src/keymap.ts`'s `KeyScope` has no `'files'`
 * member yet and that file is not ours to edit, so the scope is widened here
 * and narrowed back when the integrator adds it.
 *
 * A binding that is not in this table does not exist: the screen never compares
 * `key.name` inline.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

/** `KeyScope` plus the scope this feature owns. */
export type FilesKeyScope = KeyScope | 'files';

export type FilesBinding = Omit<Binding, 'scope'> & { scope: FilesKeyScope };

export const FILES_KEYS: readonly FilesBinding[] = [
  {
    id: 'files.down',
    scope: 'files',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down the tree.',
  },
  {
    id: 'files.up',
    scope: 'files',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up the tree.',
  },
  {
    id: 'files.first',
    scope: 'files',
    chords: [{ key: 'g' }],
    description: 'Go to the first row.',
  },
  { id: 'files.last', scope: 'files', chords: [{ key: 'G' }], description: 'Go to the last row.' },
  {
    id: 'files.open',
    scope: 'files',
    chords: [{ key: 'return' }],
    description: 'Open the file, or expand/collapse the directory.',
  },
  {
    id: 'files.collapse',
    scope: 'files',
    chords: [{ key: 'h' }, { key: 'left' }],
    description: 'Collapse the directory, or jump to its parent.',
  },
  {
    id: 'files.expand',
    scope: 'files',
    chords: [{ key: 'l' }, { key: 'right' }],
    description: 'Expand the directory.',
  },
  {
    id: 'files.filter',
    scope: 'files',
    chords: [{ key: '/' }],
    description: 'Filter the loaded rows by name. Esc clears it.',
  },
  {
    id: 'files.toggleHidden',
    scope: 'files',
    chords: [{ key: '.' }],
    description: 'Show or hide dot-prefixed entries (.kortix and .opencode always show).',
  },
  {
    id: 'files.refresh',
    scope: 'files',
    chords: [{ key: 'r' }],
    description: 'Re-read every open directory from the sandbox.',
  },
  {
    id: 'files.copyPath',
    scope: 'files',
    chords: [{ key: 'y' }],
    description: "Copy the selected row's path to the clipboard.",
  },
  {
    id: 'files.viewerDown',
    scope: 'files',
    chords: [{ key: 'J' }, { key: 'pagedown' }],
    description: 'Scroll the viewer down.',
  },
  {
    id: 'files.viewerUp',
    scope: 'files',
    chords: [{ key: 'K' }, { key: 'pageup' }],
    description: 'Scroll the viewer up.',
  },
  {
    id: 'files.back',
    scope: 'files',
    chords: [{ key: 'escape' }],
    description: 'Clear the filter, or leave the Files screen.',
  },
] as const;

/** True when `event` matches any chord of the files binding with this id. */
export function matchesFilesBinding(event: KeyEvent, id: string): boolean {
  const binding = FILES_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
