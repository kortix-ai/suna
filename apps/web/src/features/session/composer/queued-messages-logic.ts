/**
 * The decisions the queue list makes, separated from how it renders them.
 *
 * Small on purpose: keyboard reorder and focus-after-remove are the two things
 * a list like this gets subtly wrong (wrapping at the ends, focus falling back
 * to `<body>`), and both are much easier to state as a function than to catch
 * by clicking around.
 */

/**
 * The screen-reader announcement for the queue.
 *
 * Sighted users get the same fact from the numbered rows — `1` sends when this
 * turn ends, then `2` — which is why there is no visible header saying it. This
 * string exists so the change is not silent for anyone reading by ear.
 */
export function queueSummaryLabel(count: number): string {
  return `${count} queued · sends when this turn ends`;
}

/**
 * The announcement for a queue held by a stop.
 *
 * Distinct from `queueSummaryLabel` on purpose: "2 queued · sends when this turn
 * ends" is a lie while the queue is paused, and it is exactly the lie that made
 * a stopped queue look like a broken one.
 */
export function pausedSummaryLabel(count: number): string {
  return `${count} queued · paused, will not send until resumed`;
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
