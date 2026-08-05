/**
 * The decisions the queue list makes, separated from how it renders them.
 *
 * Small on purpose: keyboard reorder and focus-after-remove are the two things
 * a list like this gets subtly wrong (wrapping at the ends, focus falling back
 * to `<body>`), and both are much easier to state as a function than to catch
 * by clicking around.
 */

/** Queue length at which the list opens itself, because scanning beats guessing. */
export const QUEUE_AUTO_EXPAND_AT = 3;

/**
 * @param userToggled the user's explicit choice, or `null` if they have not made one
 */
export function shouldExpandQueue(count: number, userToggled: boolean | null): boolean {
  if (userToggled !== null) return userToggled;
  return count >= QUEUE_AUTO_EXPAND_AT;
}

/** Header text. Says what happens next, not just how many are waiting — the
 *  count alone left people unsure whether anything would send at all. */
export function queueSummaryLabel(count: number): string {
  return `${count} queued · sends when this turn ends`;
}

/**
 * Where a row lands after an arrow-key move, or `null` if it cannot move.
 *
 * Deliberately does not wrap. Pressing up on the first row wrapping to the
 * bottom would demote the message the user was promoting, and at the top of a
 * queue that is about to drain, that is the difference between "sends next" and
 * "sends last".
 *
 * @param minIndex the first movable slot — 1 while an item is in flight, since
 *   nothing may be reordered into or above a message already being sent.
 */
export function reorderTargetIndex(
  index: number,
  direction: 'up' | 'down',
  length: number,
  minIndex: number,
): number | null {
  if (index < 0 || index >= length) return null;
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < minIndex || target >= length) return null;
  return target;
}

/**
 * Which row to focus after removing the one at `removedIndex`.
 *
 * The row that slides into the vacated slot, or the one before it when the last
 * row went. `null` means the queue is empty and focus belongs back in the
 * composer — without this, focus lands on `<body>` and keyboard users lose
 * their place entirely.
 */
export function nextFocusAfterRemove(ids: string[], removedIndex: number): string | null {
  if (removedIndex < 0 || removedIndex >= ids.length) return null;
  return ids[removedIndex + 1] ?? ids[removedIndex - 1] ?? null;
}
