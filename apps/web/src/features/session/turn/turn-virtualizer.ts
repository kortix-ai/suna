/**
 * Pure decisions behind the windowed transcript.
 *
 * Windowing itself lives in `session-chat.tsx` via `@tanstack/react-virtual`,
 * but every *decision* it makes lives here as a plain function. That is
 * deliberate: apps/web renders tests through `renderToStaticMarkup`, which
 * cannot scroll, measure, or mount a virtualizer at all. Keeping the choices
 * pure is the only way any of this is verifiable without a browser.
 *
 * No React, no DOM, no import from `session-chat.tsx`.
 */

/** The only thing this module needs to know about a turn. */
interface TurnIdentityLike {
  userMessage: { info: { id: string } };
}

/**
 * First-guess height for an unmeasured turn.
 *
 * Inherited from the `contain-intrinsic-size:auto_600px` the transcript
 * already carried, so the virtualizer's initial estimate matches what the
 * browser was already assuming for off-screen turns rather than being a
 * fresh invention. Real heights replace it via `measureElement`.
 */
export const TRANSCRIPT_ESTIMATED_TURN_HEIGHT = 600;

/**
 * Turn count above which the transcript switches to the windowed path.
 *
 * Below it the transcript renders exactly as it always has. Four separate
 * systems — auto-scroll, the scroll anchor, the minimap observer, and
 * jump-to-message — read turns straight out of the DOM and were written
 * assuming every turn is mounted. Windowing breaks that assumption, so the
 * gate keeps ordinary sessions on the path those systems were built for and
 * pays the risk only where the problem actually exists.
 *
 * Same shape, and the same reasoning, as `shouldVirtualizeMarketplacePagedGrid`.
 */
export const TRANSCRIPT_VIRTUALIZE_THRESHOLD = 30;

/** Whether a thread of this many turns should render windowed. */
export function shouldVirtualizeTranscript(turnCount: number): boolean {
  return turnCount > TRANSCRIPT_VIRTUALIZE_THRESHOLD;
}

/**
 * Index of the turn whose user message has this id, or `-1`.
 *
 * `-1` rather than `0` matters: callers scroll to the returned index, and a
 * `0` for an unknown id would silently jump the reader to the top of the
 * thread instead of reporting that there is nothing to jump to.
 */
export function findTurnIndexById(
  turns: readonly TurnIdentityLike[],
  id: string | null | undefined,
): number {
  if (!id) return -1;
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].userMessage.info.id === id) return i;
  }
  return -1;
}

/**
 * Stable key for the set of turns currently mounted.
 *
 * The minimap arms an IntersectionObserver over the turns in the DOM. When
 * turns mount and unmount as the reader scrolls, that observer has to re-arm
 * or its active-turn highlight freezes. Keying on the mounted ids re-arms on
 * exactly that change — and, importantly, not on a streamed token, which
 * leaves the turn set untouched.
 */
export function renderedTurnIdsKey(ids: readonly string[]): string {
  return ids.join('\n');
}
