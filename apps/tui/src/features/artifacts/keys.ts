/**
 * The Artifacts screen's key table.
 *
 * Same `Binding` shape as `src/keymap.ts`, so the integrator can splice this
 * array into the global KEYMAP and the help overlay (`?`) renders these rows
 * with no extra work. `KeyScope` has no `'artifacts'` member yet, so the scope
 * is widened locally (`ArtifactsBinding`).
 *
 * A binding that is not in this table does not exist: the Artifacts screen
 * never compares `key.name` inline.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

/** `KeyScope` plus the scope this feature owns. */
export type ArtifactsKeyScope = KeyScope | 'artifacts';

/** A `Binding` whose scope may be `'artifacts'`. */
export interface ArtifactsBinding extends Omit<Binding, 'scope'> {
  scope: ArtifactsKeyScope;
}

export const ARTIFACTS_KEYS: readonly ArtifactsBinding[] = [
  {
    id: 'artifacts.down',
    scope: 'artifacts',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down.',
  },
  {
    id: 'artifacts.up',
    scope: 'artifacts',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up.',
  },
  {
    id: 'artifacts.first',
    scope: 'artifacts',
    chords: [{ key: 'g' }],
    description: 'Go to the first artifact.',
  },
  {
    id: 'artifacts.last',
    scope: 'artifacts',
    chords: [{ key: 'G' }],
    description: 'Go to the last artifact.',
  },
  {
    id: 'artifacts.details',
    scope: 'artifacts',
    chords: [{ key: 'return' }],
    description: 'Show the selected artifact.',
  },
  {
    id: 'artifacts.open',
    scope: 'artifacts',
    chords: [{ key: 'o' }],
    description: 'Open the artifact in the web app.',
  },
  {
    id: 'artifacts.copy',
    scope: 'artifacts',
    chords: [{ key: 'y' }],
    description: "Copy the artifact's web link.",
  },
  {
    id: 'artifacts.filter',
    scope: 'artifacts',
    chords: [{ key: '/' }],
    description: 'Filter the list by title, path or author. Esc clears it.',
  },
  {
    id: 'artifacts.refresh',
    scope: 'artifacts',
    chords: [{ key: 'r' }],
    description: 'Reload the artifact list.',
  },
  {
    id: 'artifacts.session',
    scope: 'artifacts',
    chords: [{ key: 's' }],
    description: 'Open the session that published the artifact.',
  },
  {
    id: 'artifacts.rename',
    scope: 'artifacts',
    chords: [{ key: 'e' }],
    description: 'Rename the selected artifact.',
  },
  {
    id: 'artifacts.pin',
    scope: 'artifacts',
    chords: [{ key: 'p' }],
    description: 'Pin or unpin the selected artifact.',
  },
  {
    id: 'artifacts.delete',
    scope: 'artifacts',
    chords: [{ key: 'd' }],
    description: 'Stop sharing the selected artifact (asks first).',
  },
  {
    id: 'artifacts.confirm',
    scope: 'artifacts',
    chords: [{ key: 'y' }],
    description: 'Confirm.',
  },
  { id: 'artifacts.deny', scope: 'artifacts', chords: [{ key: 'n' }], description: 'Decline.' },
  {
    id: 'artifacts.textDown',
    scope: 'artifacts',
    chords: [{ key: 'J' }, { key: 'pagedown' }],
    description: 'Scroll the document down.',
  },
  {
    id: 'artifacts.textUp',
    scope: 'artifacts',
    chords: [{ key: 'K' }, { key: 'pageup' }],
    description: 'Scroll the document up.',
  },
  {
    id: 'artifacts.submit',
    scope: 'artifacts',
    chords: [{ key: 'return' }],
    description: 'Save the new title.',
  },
  {
    id: 'artifacts.back',
    scope: 'artifacts',
    chords: [{ key: 'escape' }],
    description: 'Close the prompt, the details or the filter, then leave the screen.',
  },
] as const;

/** True when `event` matches any chord of the Artifacts binding with this id. */
export function matchesArtifactsBinding(event: KeyEvent, id: string): boolean {
  const binding = ARTIFACTS_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
