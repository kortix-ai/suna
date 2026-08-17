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
 * "All send" is load-bearing, not filler: the queue drains as one batch, and a
 * label that reads like a schedule (one row at a time) describes the behaviour
 * this surface used to have. "Next stopping point", not "when this turn ends":
 * a queued message interrupts the run once the currently executing tool call
 * finishes (see `use-message-queue-drain.ts`) — promising the end of the turn
 * would overstate the wait. Sighted users get the batch fact from the rows all
 * being live at once, which is why there is no visible header saying it.
 */
export function queueSummaryLabel(count: number): string {
  return count === 1
    ? '1 queued · sends at the next stopping point'
    : `${count} queued · all send at the next stopping point`;
}

/**
 * The announcement for a queue held by a stop.
 *
 * Distinct from `queueSummaryLabel` on purpose: "2 queued · all send when this
 * turn ends" is a lie while the queue is paused, and it is exactly the lie that
 * made a stopped queue look like a broken one.
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
 * @param minIndex the first movable slot — the size of the in-flight batch,
 *   since nothing may be reordered into or above a message already being sent.
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
 * The `toIndex` — in the FULL pending array — for moving `id` to `targetSlot`
 * in the visible list.
 *
 * Two coordinate systems meet here. The list renders `visibleIds` (pending
 * minus the in-flight batch), but the store's reorder takes a position in
 * `pendingIds`, where the in-flight batch still occupies the head. The row
 * that currently occupies `targetSlot` marks where the moved row must land in
 * the full array; passing the visible index itself would aim moves at the
 * in-flight slots the user cannot even see.
 *
 * The occupant's PRE-move index is correct for any distance, both directions,
 * because the store moves by splice-out-then-splice-in: removing the dragged
 * row first shifts the occupant into exactly the slot that puts the dragged
 * row back on the correct side of it. `null` for a no-op or an out-of-range
 * slot.
 */
export function reorderToPendingIndex(
  visibleIds: string[],
  pendingIds: string[],
  id: string,
  targetSlot: number,
): number | null {
  const index = visibleIds.indexOf(id);
  if (index === -1 || targetSlot === index) return null;
  if (targetSlot < 0 || targetSlot >= visibleIds.length) return null;
  const toIndex = pendingIds.indexOf(visibleIds[targetSlot]);
  return toIndex === -1 ? null : toIndex;
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
