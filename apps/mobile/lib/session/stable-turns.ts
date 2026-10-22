/**
 * Turn identity helpers for the session thread.
 *
 * `sessionLogTurns` keeps a turn's object while its messages and derived
 * fields do, but returns a new array on every call. The list skips a render
 * only when its `data` keeps the same reference.
 */

/** `prev` itself when `next` holds the same turn objects in the same order; else `next`. */
export function reuseStableTurns<T>(prev: readonly T[], next: T[]): T[] {
  if (prev.length !== next.length) return next;
  for (let i = 0; i < next.length; i++) if (prev[i] !== next[i]) return next;
  return prev as T[];
}

/**
 * The footer spacer height is `max(0, cap - lastTurnHeight)`. It changes only
 * when the last turn height, clamped to `[0, cap]`, changes. Heights at or
 * above the cap all produce a zero spacer.
 */
export function shouldUpdateSpacer(prevHeight: number, nextHeight: number, cap: number): boolean {
  const limit = Math.max(0, cap);
  return Math.min(Math.max(0, prevHeight), limit) !== Math.min(Math.max(0, nextHeight), limit);
}

/** A user scroll that moves up further than this from the end releases the stick. */
export const STICK_RELEASE_DISTANCE = 48;
/** A settled user scroll within this distance of the end re-arms the stick. */
const NEAR_END_DISTANCE = 80;

/**
 * Stick-to-end: while set, every content-size change scrolls the thread to its
 * end. It is released only by user intent. A scroll event releases it when it
 * is not caused by the app's own scroll call, moves the offset up, and leaves
 * the offset more than STICK_RELEASE_DISTANCE above the end (for example the
 * iOS status-bar tap). Heights come from the same scroll event, so a stale
 * content height cannot release it.
 */
export function shouldReleaseStick({
  prevOffset,
  offset,
  contentHeight,
  viewportHeight,
  programmatic,
}: {
  prevOffset: number;
  offset: number;
  contentHeight: number;
  viewportHeight: number;
  programmatic: boolean;
}): boolean {
  if (programmatic) return false;
  if (offset >= prevOffset) return false;
  return contentHeight - offset - viewportHeight > STICK_RELEASE_DISTANCE;
}

/** True when the offset is within NEAR_END_DISTANCE of the end, or the content fits the viewport. */
export function isNearEnd(offset: number, contentHeight: number, viewportHeight: number): boolean {
  return contentHeight - offset - viewportHeight <= NEAR_END_DISTANCE;
}

/** Drag-end velocities below this count as "no momentum follows". */
const MOMENTUM_VELOCITY_EPSILON = 0.01;

/**
 * A settled user scroll near the end re-arms the stick. At finger lift
 * (`onScrollEndDrag`) a non-zero velocity means momentum follows, so the
 * decision waits for `onMomentumScrollEnd`, which passes no velocity.
 * Re-arming before momentum would snap a fling away from the end back to it.
 * iOS also reports where the scroll will come to rest (`targetOffsetY`): when
 * that equals the current offset, no momentum follows whatever the velocity.
 */
export function shouldRearmStick({
  offset,
  contentHeight,
  viewportHeight,
  programmatic,
  velocityY,
  targetOffsetY,
}: {
  offset: number;
  contentHeight: number;
  viewportHeight: number;
  programmatic: boolean;
  velocityY?: number;
  targetOffsetY?: number;
}): boolean {
  if (programmatic) return false;
  const momentumFollows =
    velocityY !== undefined &&
    Math.abs(velocityY) > MOMENTUM_VELOCITY_EPSILON &&
    targetOffsetY !== offset;
  if (momentumFollows) return false;
  return isNearEnd(offset, contentHeight, viewportHeight);
}

/**
 * A new turn that the user did not send (another client, a trigger, a menu
 * action) scrolls into view when the thread was effectively at its end: the
 * stick was released only by a touch on the idle thread, or the last settled
 * user scroll rested near the end.
 */
export function shouldFollowNewTurn({
  grew,
  releasedByTouch,
  settledNearEnd,
}: {
  grew: boolean;
  releasedByTouch: boolean;
  settledNearEnd: boolean;
}): boolean {
  return grew && (releasedByTouch || settledNearEnd);
}

/**
 * A touch on the thread releases the stick on an idle session, so a card the
 * user expands opens in place instead of being scrolled away. While the
 * session streams, a touch keeps following; a drag or a scroll away still
 * releases it.
 */
export function shouldReleaseStickOnTouch({ isBusy }: { isBusy: boolean }): boolean {
  return !isBusy;
}
