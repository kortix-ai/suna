/**
 * The decisions the queue list makes, separated from how it renders them.
 *
 * Small on purpose: keyboard reorder and focus-after-remove are the two things
 * a list like this gets subtly wrong (wrapping at the ends, focus falling back
 * to `<body>`), and both are much easier to state as a function than to catch
 * by clicking around.
 */

import { QUEUE_FULL_HINT_KEY, nextQueueOrderAfterMoveToTop } from './queue-gates';

/**
 * Where a row lands after an arrow-key move, or `null` if it cannot move.
 *
 * Deliberately does not wrap. Pressing up on the first row wrapping to the
 * bottom would demote the message the user was promoting, and at the top of a
 * queue that is about to drain, that is the difference between "sends next" and
 * "sends last".
 *
 * @param minIndex the first movable slot. It was the size of the in-flight
 *   batch, back when in-flight rows were hidden and always occupied the head of
 *   the list. They are RENDERED now, in place, wherever the server ordered them
 *   — so there is no leading batch to step over and the only caller passes `0`.
 *   Kept as a parameter rather than removed: it is the one line that would have
 *   to change if the list ever pins in-flight rows to the top again, and the
 *   bound is cheap to honour.
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
 * TODAY THE TWO ARRAYS ARE THE SAME ARRAY, so this is an identity map with a
 * validity check — and that is worth saying, because the doc it replaces
 * described a store that no longer exists.
 *
 * It was written when the list rendered `visibleIds` (pending minus the
 * in-flight batch) while the store's reorder took a position in `pendingIds`,
 * where the in-flight batch still occupied the head. In-flight rows are
 * RENDERED now, in place — `QueuedMessagesProps.inFlightIds` — so `visibleIds`
 * and `pendingIds` carry the same rows in the same order and the lookup
 * resolves to `targetSlot` itself.
 *
 * What is still load-bearing is the REFUSAL: `null` for a row that is not in
 * the list, for a no-op move, and for an out-of-range slot. The caller fires a
 * network reorder on any non-null answer, so a permissive version here is a
 * request the server has nothing to persist.
 *
 * The occupant's PRE-move index is what a caller wants for any distance in
 * either direction, because the move is splice-out-then-splice-in: removing the
 * dragged row first shifts the occupant into exactly the slot that puts the
 * dragged row back on the correct side of it.
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

/**
 * The id of the row that goes out next, or `null` when no row does.
 *
 * Two kinds of row are skipped, for opposite reasons. An in-flight row is
 * already gone — labelling it "runs next" describes the past. A parked row is
 * held out of the drain on purpose. A queue of nothing but parked rows
 * therefore marks NO row: promoting one of them would name a row the drain
 * skips, which is the exact wrong thing to tell someone deciding what to
 * reorder.
 */
export function runsNextId(
  rows: readonly { id: string; parked?: boolean }[],
  inFlightIds: readonly string[],
): string | null {
  const inFlight = new Set(inFlightIds);
  for (const row of rows) {
    if (row.parked) continue;
    if (inFlight.has(row.id)) continue;
    return row.id;
  }
  return null;
}

/**
 * May `id` be promoted to the top of `orderedIds`?
 *
 * Delegates to `nextQueueOrderAfterMoveToTop` instead of testing `indexOf > 0`
 * here. The menu item and the reorder it fires have to agree about what counts
 * as a no-op; two independent copies of that rule are how a "Move to top" that
 * moves nothing — or worse, fires a reorder request for a row that never
 * moved — gets shipped.
 */
export function canMoveToTop(orderedIds: readonly string[], id: string): boolean {
  return nextQueueOrderAfterMoveToTop(orderedIds, id) !== null;
}

/**
 * The depth to ANNOUNCE for a queue that just grew, or `null` when it did not.
 *
 * Only growth speaks. A drain and a removal both shrink the queue, and both
 * are already announced by the action that caused them; re-announcing every
 * shrink as queue news is how a live region becomes the noise a screen-reader
 * user switches off.
 *
 * A number, not a sentence. A new row lands at the end, so its position IS the
 * new depth — the caller renders "position 3 of 3" from the catalog
 * (`QUEUE_GROWTH_ANNOUNCEMENT_KEY`), which is where a nine-locale UI's words
 * have to live.
 */
export function queueGrowthDepth(previousDepth: number, depth: number): number | null {
  return depth > previousDepth ? depth : null;
}

/** 'Message queued, position {position} of {total}.' */
export const QUEUE_GROWTH_ANNOUNCEMENT_KEY = 'text10beb96925c2';
/** 'Moved to position {position} of {total}' */
export const QUEUE_MOVE_ANNOUNCEMENT_KEY = 'text3425d4d6d43a';

/**
 * The cap the SERVER puts on a listed prompt's text.
 *
 * `PROMPT_TEXT_PREVIEW_CHARS` in
 * `apps/api/src/projects/session-lifecycle/prompt-parts.ts`, applied as
 * `payload.text.slice(0, 2000)` when a row is projected for the list. The
 * value is duplicated rather than imported because nothing in `apps/web`
 * imports from `apps/api`; `promptTextMatches` in `inbox-row-claims.ts` keeps
 * its own copy for the same reason.
 */
const PROMPT_TEXT_PREVIEW_CHARS = 2000;

/**
 * Is this row's text the server's TRUNCATED preview rather than the whole
 * message?
 *
 * `>= 2000 - 1` and not `>= 2000`, matching `promptTextMatches`: the slice is
 * exact, but a message that lands one character under the cap is
 * indistinguishable from one that was cut, and the cheap direction to be wrong
 * in is "assume it was cut".
 */
function textIsPreviewCapped(text: string): boolean {
  return text.length >= PROMPT_TEXT_PREVIEW_CHARS - 1;
}

/** Shown on a Duplicate the list refuses because the copy would lose words.
 *  A catalog key ('Too long to copy faithfully') — see `QUEUE_FULL_HINT_KEY`
 *  for why the words are not written here. */
export const DUPLICATE_CAPPED_HINT_KEY = 'texta60d3285f84f';
/** Shown on a Duplicate the list refuses because the copy would lose files.
 *  A catalog key ("Can't copy attachments"). */
export const DUPLICATE_ATTACHMENTS_HINT_KEY = 'text33260dd2478a';

/**
 * Can this row be copied FAITHFULLY — same words, same files?
 *
 * Two rows cannot, and both fail silently if the menu offers them anyway:
 *
 *   - **A preview-capped row.** `SessionPrompt.text` is a 2000-char preview,
 *     not the message. A copy built from it is the first 2000 characters of
 *     what the user wrote, and nothing on screen says so.
 *   - **A row with attachments.** The list carries its files by NAME only
 *     (`SessionPrompt.attachments`); the parts themselves come back only in
 *     the `DELETE .../prompts/:id` response, which a copy obviously must not
 *     issue. So the copy would carry the words without the files.
 *
 * A lossy Duplicate is worse than no Duplicate: the queue then holds two rows
 * that look alike and send different things. The menu disables the item and
 * says which of the two reasons applies (`duplicateBlockedHint`).
 */
export function canDuplicateRow(row: { text: string; attachmentCount?: number }): boolean {
  if ((row.attachmentCount ?? 0) > 0) return false;
  return !textIsPreviewCapped(row.text);
}

/**
 * Why Duplicate is disabled for this row — as a catalog key — or `null` when it
 * is offered.
 *
 * One function for all three refusals so the `disabled` flag and the sentence
 * explaining it can never disagree — a disabled item with no reason is the
 * failure this replaces.
 *
 * The cap outranks the row's own losses: at the cap NOTHING can be duplicated,
 * so naming the row's problem would send the user off editing a message when
 * the queue is what needs draining.
 */
export function duplicateBlockedHintKey(
  row: { text: string; attachmentCount?: number },
  queueAtCap: boolean,
): string | null {
  if (queueAtCap) return QUEUE_FULL_HINT_KEY;
  if ((row.attachmentCount ?? 0) > 0) return DUPLICATE_ATTACHMENTS_HINT_KEY;
  if (textIsPreviewCapped(row.text)) return DUPLICATE_CAPPED_HINT_KEY;
  return null;
}
