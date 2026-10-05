/**
 * The session transcript's scroll physics — a port of apps/web
 * `src/hooks/use-auto-scroll.ts` to a React Native `FlatList`. Pure; the
 * wiring lives in `components/session/SessionPage.tsx`.
 *
 * FACT 1 — the room. Under the newest turn there is always
 *
 *     spacer = max(BOTTOM_GAP_PX, viewportH − anchorSpanH − topOffset)
 *
 * of empty space, so the newest turn can sit `topOffset` below the top of the
 * list. It is the same while streaming and when idle: nothing moves when an
 * answer finishes.
 *
 * FACT 2 — the end. Because of that room, `contentH − viewportH` IS the newest
 * turn at the top while the answer fits in the room, and the tail of the
 * answer once it has outgrown it. One position; no anchor-vs-follow phases.
 *
 * THE RULE — follow. While `follow` is on, every layout change puts the list
 * back at the end. It turns off on reader intent (a drag, or a foreign scroll
 * away from the end such as the iOS status-bar tap) and on again when the
 * reader comes back to the end, taps the scroll-to-bottom button, or sends.
 *
 * THE MOTION — one per change. A send and a newly reached turn move the list
 * by a whole turn in ONE animated scroll (a glide); a glide whose end moves in
 * flight is re-aimed, never cut short.
 */

/** Distance (pt) between the newest turn's top and the list's top at the end. */
export const TURN_TOP_OFFSET = 24;
/** The room's floor (pt): the only gap under a turn taller than the viewport. */
export const BOTTOM_GAP_PX = 24;
/** Within this distance of the end the reader counts as AT the end. */
export const AT_END_PX = 4;
/** Distance of CONTENT (room excluded) from the end past which the button shows. */
export const CHEVRON_PX = 120;
/** A turn-sized move shorter than this is a cut, not a glide. */
export const GLIDE_MIN_PX = 80;
/** A glide has landed once its scroll events stop for this long. */
export const GLIDE_QUIET_MS = 120;
/** Hard stop for a glide that never reports landing. Web's value. */
export const GLIDE_MAX_MS = 1200;
/** How long a send's armed glide waits for the layout that carries its turn. */
export const SEND_GLIDE_ARM_MS = 1000;
/**
 * How long after an instant programmatic scroll a scroll event still counts as
 * ours. Web uses 80ms (one frame of slack); React Native delivers scroll events
 * asynchronously from the native side, so mobile keeps its measured 300ms.
 */
export const OWN_SCROLL_MS = 300;

/** Web `mt-12` between turns: 12 × 0.23rem = 44.16px. */
export const TURN_GAP_PX = 44;
/** Web `mt-3` between back-to-back queued turns: 3 × 0.23rem = 11.04px. */
export const QUEUED_TURN_GAP_PX = 11;

export function distanceFromEnd(input: {
  offset: number;
  contentHeight: number;
  viewportHeight: number;
}): number {
  return input.contentHeight - input.offset - input.viewportHeight;
}

/** The largest valid scroll offset. */
export function scrollEnd(contentHeight: number, viewportHeight: number): number {
  return Math.max(0, contentHeight - viewportHeight);
}

/** Negative distances (iOS rubber-band past the end) count as at the end. */
export function isAtEnd(distance: number): boolean {
  return distance <= AT_END_PX;
}

/** The spacer under the anchor turn. `null` span (no anchor) → the whole viewport. */
export function roomUnderNewestTurn(
  viewportHeight: number,
  anchorSpanHeight: number | null,
  topOffset: number = TURN_TOP_OFFSET,
): number {
  if (anchorSpanHeight === null) return viewportHeight;
  return Math.max(BOTTOM_GAP_PX, viewportHeight - anchorSpanHeight - topOffset);
}

/**
 * Which turn (by list order) the room is measured from: the newest turn the
 * agent has reached, else the last turn. A reached anchor never falls back to
 * an older turn while it is still in the transcript (web `pickAnchorIndex`).
 */
export function pickAnchorIndex(
  count: number,
  isPending: (index: number) => boolean,
  previous: { index: number; reached: boolean } | null,
): number {
  if (count === 0) return -1;
  let candidate = count - 1;
  for (let i = count - 1; i >= 0; i--) {
    if (!isPending(i)) {
      candidate = i;
      break;
    }
  }
  if (previous?.reached && previous.index > candidate && previous.index < count) {
    return previous.index;
  }
  return candidate;
}

/**
 * Height from the anchor turn's top to the end of the content, spacer
 * excluded: the anchor's height, every later turn's top gap and height, and the
 * footer content above the spacer. `null` when there is no anchor or a turn in
 * that range has not been measured yet.
 */
export function anchorSpan(input: {
  anchorIndex: number;
  count: number;
  heightAt: (index: number) => number | undefined;
  gapAt: (index: number) => number;
  footerHeight: number;
}): number | null {
  const { anchorIndex, count } = input;
  if (anchorIndex < 0 || anchorIndex >= count) return null;
  let span = input.footerHeight;
  for (let i = anchorIndex; i < count; i++) {
    const height = input.heightAt(i);
    if (height === undefined) return null;
    span += height;
    if (i > anchorIndex) span += input.gapAt(i);
  }
  return span;
}

/**
 * Top gap of a turn — web `session-chat.tsx`: `turnIndex === 0 ? '' :
 * lastTurnWorking && pending(turn) && pending(previous turn) ? 'mt-3' : 'mt-12'`.
 */
export function turnTopGap(input: {
  index: number;
  working: boolean;
  pending: boolean;
  previousPending: boolean;
}): number {
  if (input.index === 0) return 0;
  if (input.working && input.pending && input.previousPending) return QUEUED_TURN_GAP_PX;
  return TURN_GAP_PX;
}

/** Does the scroll-to-bottom button show? Only for a reader who is not following. */
export function chevronVisible(input: {
  following: boolean;
  distanceFromEnd: number;
  room: number;
}): boolean {
  if (input.following) return false;
  return input.distanceFromEnd - input.room > CHEVRON_PX;
}

export type FollowEvent =
  /** The reader put a finger on the list and started a drag. */
  | { type: 'drag-begin' }
  /** The reader sent a prompt. */
  | { type: 'send' }
  /** The scroll-to-bottom button, or any explicit "go to the end". */
  | { type: 'jump-to-end' }
  /** A scroll event. `ours`: inside a programmatic-scroll window.
   *  `geometryChanged`: content or viewport height moved since the last event. */
  | {
      type: 'scroll';
      ours: boolean;
      geometryChanged: boolean;
      movedTowardEnd: boolean;
      dragging: boolean;
      distanceFromEnd: number;
    }
  /** A user scroll came to rest (drag end with no momentum, or momentum end). */
  | { type: 'rest'; distanceFromEnd: number };

/**
 * THE RULE's transitions.
 *
 * - drag → off. Web reads touch/wheel intent; on a phone every reader scroll
 *   starts with a drag.
 * - send / jump-to-end → on.
 * - scroll → off only for a scroll that is not ours, is not a clamp, and left
 *   the end (web `shouldReleaseFollow`: the iOS status-bar tap is one).
 *   → on when it ARRIVED at the end moving toward it with no finger down
 *   (momentum of a fling). Direction matters: the first frame of a scroll up
 *   is still inside AT_END_PX.
 * - rest → on at the end. A finger that let go at the end is back.
 */
export function nextFollow(following: boolean, event: FollowEvent): boolean {
  switch (event.type) {
    case 'drag-begin':
      return false;
    case 'send':
    case 'jump-to-end':
      return true;
    case 'rest':
      return following || isAtEnd(event.distanceFromEnd);
    case 'scroll':
      if (following) {
        if (event.ours || event.geometryChanged) return true;
        return isAtEnd(event.distanceFromEnd);
      }
      return !event.dragging && event.movedTowardEnd && isAtEnd(event.distanceFromEnd);
  }
}

export type SettleMotion = 'none' | 'instant' | 'glide' | 'wait';

/**
 * How a FOLLOWING list gets to the end after a layout change (web
 * `settleMotion`, unchanged).
 *
 * - glide in flight: re-aim at a moved end, else let it land ('wait').
 * - a whole-turn move (new anchor, or a send's armed glide) over GLIDE_MIN_PX:
 *   glide.
 * - everything else (text streaming under the anchor): instant.
 */
export function settleMotion(input: {
  distance: number;
  end: number;
  anchorChanged: boolean;
  glideArmed: boolean;
  glideTarget: number | null;
  reduceMotion: boolean;
}): SettleMotion {
  if (input.glideTarget !== null) {
    return Math.abs(input.end - input.glideTarget) > 1 ? 'glide' : 'wait';
  }
  if (input.distance <= 0.5) return 'none';
  if (
    (input.anchorChanged || input.glideArmed) &&
    input.distance > GLIDE_MIN_PX &&
    !input.reduceMotion
  ) {
    return 'glide';
  }
  return 'instant';
}

/** Drag-end velocities below this count as "no momentum follows". */
const MOMENTUM_VELOCITY_EPSILON = 0.01;

/**
 * At finger lift (`onScrollEndDrag`), does a momentum scroll follow? A non-zero
 * velocity means yes, so the "rest" decision waits for `onMomentumScrollEnd`.
 * iOS also reports where the scroll will come to rest (`targetOffsetY`): equal
 * to the current offset means no momentum, whatever the velocity.
 */
export function momentumFollows(input: {
  offset: number;
  velocityY: number | undefined;
  targetOffsetY: number | undefined;
}): boolean {
  return (
    input.velocityY !== undefined &&
    Math.abs(input.velocityY) > MOMENTUM_VELOCITY_EPSILON &&
    input.targetOffsetY !== input.offset
  );
}
