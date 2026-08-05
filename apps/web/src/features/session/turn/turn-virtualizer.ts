/**
 * Stable key for the set of transcript rows currently mounted.
 *
 * The minimap arms an IntersectionObserver over the turns in the DOM. When rows
 * mount and unmount as the reader scrolls, an observer armed once never sees
 * the ones that arrive later and its active-turn highlight freezes. Keying on
 * the mounted ids re-arms on exactly that change — and, importantly, not on a
 * streamed token, which leaves the mounted set untouched.
 *
 * What used to live here — `TRANSCRIPT_ESTIMATED_TURN_HEIGHT` and
 * `findTurnIndexById` — belonged to the turn-granular virtualizer. That design
 * windowed nothing (a turn spans an entire agent session, so `count` was 1),
 * and both helpers went with it. Row height estimates now live in
 * `@/hooks/virtual-list-core`; lookup is by row key via the list's
 * `scrollToKey`.
 *
 * No React, no DOM.
 */
export function renderedTurnIdsKey(ids: readonly string[]): string {
  return ids.join('\n');
}
