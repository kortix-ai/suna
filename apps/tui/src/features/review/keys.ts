/**
 * The Review screen's key table.
 *
 * Same `Binding` shape as `src/keymap.ts`, scoped `'review'`, so the integrator
 * splices this array into the global KEYMAP and the help overlay (`?`) renders
 * these rows with no extra work. `src/keymap.ts`'s `KeyScope` has no `'review'`
 * member yet and that file is not ours to edit, so the scope is widened here
 * and narrowed back when the integrator adds it.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

/** `KeyScope` plus the scope this feature owns. */
export type ReviewKeyScope = KeyScope | 'review';

export type ReviewBinding = Omit<Binding, 'scope'> & { scope: ReviewKeyScope };

export const REVIEW_KEYS: readonly ReviewBinding[] = [
  {
    id: 'review.down',
    scope: 'review',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down the list.',
  },
  {
    id: 'review.up',
    scope: 'review',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up the list.',
  },
  {
    id: 'review.first',
    scope: 'review',
    chords: [{ key: 'g' }],
    description: 'Go to the first change request.',
  },
  {
    id: 'review.last',
    scope: 'review',
    chords: [{ key: 'G' }],
    description: 'Go to the last change request.',
  },
  {
    id: 'review.open',
    scope: 'review',
    chords: [{ key: 'return' }],
    description: 'Open the diff.',
  },
  {
    id: 'review.toggleView',
    scope: 'review',
    chords: [{ key: 's' }],
    description: 'Switch the diff between unified and split.',
  },
  {
    id: 'review.nextFile',
    scope: 'review',
    chords: [{ key: 'n' }],
    description: 'Next file in the diff.',
  },
  {
    id: 'review.prevFile',
    scope: 'review',
    chords: [{ key: 'p' }],
    description: 'Previous file in the diff.',
  },
  {
    id: 'review.scrollDown',
    scope: 'review',
    chords: [{ key: 'J' }, { key: 'pagedown' }],
    description: 'Scroll the diff down.',
  },
  {
    id: 'review.scrollUp',
    scope: 'review',
    chords: [{ key: 'K' }, { key: 'pageup' }],
    description: 'Scroll the diff up.',
  },
  {
    id: 'review.approve',
    scope: 'review',
    chords: [{ key: 'a' }],
    description:
      'Approve. Not a separate Kortix action — approving a change request is merging it.',
  },
  {
    id: 'review.merge',
    scope: 'review',
    chords: [{ key: 'm' }],
    description: 'Merge the change request into its base (asks first).',
  },
  {
    id: 'review.close',
    scope: 'review',
    chords: [{ key: 'x' }],
    description: 'Close the change request without merging (asks first).',
  },
  {
    id: 'review.openSession',
    scope: 'review',
    chords: [{ key: 'o' }],
    description: 'Open the session this change request came from.',
  },
  {
    id: 'review.refresh',
    scope: 'review',
    chords: [{ key: 'r' }],
    description: 'Re-read the change requests.',
  },
  {
    id: 'review.confirm',
    scope: 'review',
    chords: [{ key: 'y' }],
    description: 'Confirm the merge or the close.',
  },
  {
    id: 'review.back',
    scope: 'review',
    chords: [{ key: 'escape' }],
    description: 'Cancel the confirm, close the diff, or leave the Review screen.',
  },
] as const;

/** True when `event` matches any chord of the review binding with this id. */
export function matchesReviewBinding(event: KeyEvent, id: string): boolean {
  const binding = REVIEW_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
