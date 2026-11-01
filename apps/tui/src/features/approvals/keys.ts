/**
 * The Approvals screen's key table (the web's Review Center).
 *
 * Same `Binding` shape as `src/keymap.ts`; the scope is widened locally
 * (`ScreenBinding`) because `KeyScope` has no `'approvals'` member and
 * widening a shared file is the integrator's call. A binding that is not in
 * this table does not exist.
 *
 * Verdict keys (`a` `x` `c` `d` `w`, digits) work only in the detail pane. An
 * approval is never decided from the list: the person reads the parameters
 * first, as the web requires.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

/** `KeyScope` plus the scope this feature owns. Local until `keymap.ts` widens. */
export type ScreenScope = KeyScope | 'approvals';

/** A `Binding` whose scope may be `'approvals'`. */
export interface ScreenBinding extends Omit<Binding, 'scope'> {
  scope: ScreenScope;
}

const DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

export const APPROVALS_KEYS: readonly ScreenBinding[] = [
  {
    id: 'approvals.down',
    scope: 'approvals',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down (in the detail: scroll).',
  },
  {
    id: 'approvals.up',
    scope: 'approvals',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up (in the detail: scroll).',
  },
  {
    id: 'approvals.first',
    scope: 'approvals',
    chords: [{ key: 'g' }],
    description: 'Go to the top.',
  },
  {
    id: 'approvals.last',
    scope: 'approvals',
    chords: [{ key: 'G' }],
    description: 'Go to the bottom.',
  },
  {
    id: 'approvals.segment.next',
    scope: 'approvals',
    chords: [{ key: 'l' }, { key: 'right' }, { key: 'tab' }],
    description: 'Next list: Needs you, Waiting, Done.',
  },
  {
    id: 'approvals.segment.prev',
    scope: 'approvals',
    chords: [{ key: 'h' }, { key: 'left' }],
    description: 'Previous list.',
  },
  {
    id: 'approvals.open',
    scope: 'approvals',
    chords: [{ key: 'return' }],
    description: 'Open the item.',
  },
  {
    id: 'approvals.approve',
    scope: 'approvals',
    chords: [{ key: 'a' }],
    description: 'Approve (a change request: merge it). Asks first.',
  },
  {
    id: 'approvals.reject',
    scope: 'approvals',
    chords: [{ key: 'x' }],
    description: 'Reject (a change request: close it). Reason optional.',
  },
  {
    id: 'approvals.changes',
    scope: 'approvals',
    chords: [{ key: 'c' }],
    description: 'Ask for changes. A note is required.',
  },
  {
    id: 'approvals.dismiss',
    scope: 'approvals',
    chords: [{ key: 'd' }],
    description: 'Dismiss the item. Asks first.',
  },
  {
    id: 'approvals.answer',
    scope: 'approvals',
    chords: [{ key: 'w' }],
    description: 'Answer a decision in your own words.',
  },
  {
    id: 'approvals.option',
    scope: 'approvals',
    chords: DIGITS.map((key) => ({ key })),
    description: 'Answer a decision with option 1 to 9. Asks first.',
  },
  {
    id: 'approvals.session',
    scope: 'approvals',
    chords: [{ key: 's' }],
    description: 'Open the session that raised the item.',
  },
  {
    id: 'approvals.web',
    scope: 'approvals',
    chords: [{ key: 'o' }],
    description: 'Open the item in the browser.',
  },
  {
    id: 'approvals.refresh',
    scope: 'approvals',
    chords: [{ key: 'r' }],
    description: 'Reload the list.',
  },
  {
    id: 'approvals.confirm',
    scope: 'approvals',
    chords: [{ key: 'y' }, { key: 'return' }],
    description: 'Confirm.',
  },
  { id: 'approvals.deny', scope: 'approvals', chords: [{ key: 'n' }], description: 'Decline.' },
  {
    id: 'approvals.back',
    scope: 'approvals',
    chords: [{ key: 'escape' }],
    description: 'Leave the detail, the input, or the screen.',
  },
] as const;

/** True when `event` matches any chord of the Approvals binding with this id. */
export function matchesApprovalsBinding(event: KeyEvent, id: string): boolean {
  const binding = APPROVALS_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}

/** The 0-based option a digit key picks, or `null` when `event` is not a digit binding. */
export function optionIndexOf(event: KeyEvent): number | null {
  if (!matchesApprovalsBinding(event, 'approvals.option')) return null;
  return Number(event.name) - 1;
}
