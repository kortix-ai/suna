/**
 * The Customize screen's key table.
 *
 * Same `Binding` shape as `src/keymap.ts`, so the integrator can splice this
 * array into the global KEYMAP and the help overlay (`?`) renders these rows
 * with no extra work. `KeyScope` has no `'customize'` member yet and widening
 * a shared file is the integrator's call, so the scope is widened locally.
 * The same four lines exist in `features/apps/keys.ts`: SPEC §3 forbids one
 * feature importing another's internals, and the shared home for this type is
 * `keymap.ts`, which wave 2 does not own.
 *
 * A binding that is not in this table does not exist: no screen in this
 * folder compares `key.name` inline.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

/** `KeyScope` plus the screens wave 2 adds. Local until `keymap.ts` widens. */
export type ScreenScope = KeyScope | 'apps' | 'customize';

/** A `Binding` whose scope may be one of the wave-2 screens. */
export interface ScreenBinding extends Omit<Binding, 'scope'> {
  scope: ScreenScope;
}

/** The tab strip, left to right. The digit keys follow this order. */
export const CUSTOMIZE_TABS = [
  { id: 'agents', label: 'Agents' },
  { id: 'skills', label: 'Skills' },
  { id: 'secrets', label: 'Secrets' },
  { id: 'triggers', label: 'Triggers' },
  { id: 'connectors', label: 'Connectors' },
] as const;

export type CustomizeTabId = (typeof CUSTOMIZE_TABS)[number]['id'];

export const CUSTOMIZE_KEYS: readonly ScreenBinding[] = [
  {
    id: 'customize.tab',
    scope: 'customize',
    chords: [{ key: '1' }, { key: '2' }, { key: '3' }, { key: '4' }, { key: '5' }],
    description: 'Jump to the Nth tab.',
  },
  {
    id: 'customize.tabNext',
    scope: 'customize',
    chords: [{ key: ']' }],
    description: 'Next tab.',
  },
  {
    id: 'customize.tabPrev',
    scope: 'customize',
    chords: [{ key: '[' }],
    description: 'Previous tab.',
  },
  {
    id: 'customize.down',
    scope: 'customize',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down.',
  },
  {
    id: 'customize.up',
    scope: 'customize',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up.',
  },
  {
    id: 'customize.first',
    scope: 'customize',
    chords: [{ key: 'g' }],
    description: 'Go to the first row.',
  },
  {
    id: 'customize.last',
    scope: 'customize',
    chords: [{ key: 'G' }],
    description: 'Go to the last row.',
  },
  {
    id: 'customize.open',
    scope: 'customize',
    chords: [{ key: 'return' }],
    description: 'Show the details of the selected row.',
  },
  {
    id: 'customize.new',
    scope: 'customize',
    chords: [{ key: 'n' }],
    description: 'Add a secret (Secrets tab).',
  },
  {
    id: 'customize.delete',
    scope: 'customize',
    chords: [{ key: 'd' }],
    description: 'Delete the selected secret (asks first).',
  },
  {
    id: 'customize.toggle',
    scope: 'customize',
    // A terminal reports the space bar as `space` under the kitty protocol and
    // as the raw byte in a plain raw-mode terminal. Both are bound.
    chords: [{ key: 'space' }, { key: ' ' }, { key: 't' }],
    description: 'Pause or resume the selected trigger.',
  },
  {
    id: 'customize.refresh',
    scope: 'customize',
    chords: [{ key: 'r' }],
    description: 'Reload the active tab.',
  },
  {
    id: 'customize.confirm',
    scope: 'customize',
    chords: [{ key: 'y' }],
    description: 'Confirm.',
  },
  { id: 'customize.deny', scope: 'customize', chords: [{ key: 'n' }], description: 'Decline.' },
  {
    id: 'customize.submit',
    scope: 'customize',
    chords: [{ key: 'return' }],
    description: 'Submit the input.',
  },
  {
    id: 'customize.cancel',
    scope: 'customize',
    chords: [{ key: 'escape' }],
    description: 'Close the input, the details, or the screen.',
  },
] as const;

/** True when `event` matches any chord of the Customize binding with this id. */
export function matchesCustomizeBinding(event: KeyEvent, id: string): boolean {
  const binding = CUSTOMIZE_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}

/**
 * The tab index a digit key selects, or -1.
 *
 * `1`–`5` only; a sixth tab would need a sixth digit and this returns -1 for
 * it rather than silently selecting nothing.
 */
export function tabIndexForDigit(event: KeyEvent, tabCount: number): number {
  if (event.ctrl || event.option || event.meta) return -1;
  if (!event.name || event.name.length !== 1) return -1;
  const digit = Number(event.name);
  if (!Number.isInteger(digit) || digit < 1 || digit > tabCount) return -1;
  return digit - 1;
}
