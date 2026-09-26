/**
 * The Apps screen's key table.
 *
 * Same `Binding` shape as `src/keymap.ts`, so the integrator can splice this
 * array into the global KEYMAP and the help overlay (`?`) renders these rows
 * with no extra work. `KeyScope` in `keymap.ts` has no `'apps'` member yet and
 * widening a shared file is the integrator's call, so the scope is widened
 * locally instead (`ScreenBinding`).
 *
 * A binding that is not in this table does not exist: the Apps screen never
 * compares `key.name` inline.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

/** `KeyScope` plus the screens wave 2 adds. Local until `keymap.ts` widens. */
export type ScreenScope = KeyScope | 'apps' | 'customize';

/** A `Binding` whose scope may be one of the wave-2 screens. */
export interface ScreenBinding extends Omit<Binding, 'scope'> {
  scope: ScreenScope;
}

export const APPS_KEYS: readonly ScreenBinding[] = [
  {
    id: 'apps.down',
    scope: 'apps',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down.',
  },
  {
    id: 'apps.up',
    scope: 'apps',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up.',
  },
  { id: 'apps.first', scope: 'apps', chords: [{ key: 'g' }], description: 'Go to the first App.' },
  { id: 'apps.last', scope: 'apps', chords: [{ key: 'G' }], description: 'Go to the last App.' },
  {
    id: 'apps.details',
    scope: 'apps',
    chords: [{ key: 'return' }],
    description: 'Show the deploy details of the selected App.',
  },
  {
    id: 'apps.open',
    scope: 'apps',
    chords: [{ key: 'o' }],
    description: "Open the App's URL in the browser.",
  },
  {
    id: 'apps.copy',
    scope: 'apps',
    chords: [{ key: 'y' }],
    description: "Copy the App's URL.",
  },
  {
    id: 'apps.refresh',
    scope: 'apps',
    chords: [{ key: 'r' }],
    description: 'Reload the App list.',
  },
  {
    id: 'apps.state',
    scope: 'apps',
    chords: [{ key: 'd' }],
    description: 'Start or stop the selected App (asks first).',
  },
  {
    id: 'apps.visibility',
    scope: 'apps',
    chords: [{ key: 'v' }],
    description: 'Change who may open the selected App.',
  },
  {
    id: 'apps.confirm',
    scope: 'apps',
    chords: [{ key: 'y' }, { key: 'return' }],
    description: 'Confirm.',
  },
  { id: 'apps.deny', scope: 'apps', chords: [{ key: 'n' }], description: 'Decline.' },
  {
    id: 'apps.back',
    scope: 'apps',
    chords: [{ key: 'escape' }],
    description: 'Leave the details, the picker, or the screen.',
  },
] as const;

/** True when `event` matches any chord of the Apps binding with this id. */
export function matchesAppsBinding(event: KeyEvent, id: string): boolean {
  const binding = APPS_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
