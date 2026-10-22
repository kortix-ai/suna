/** Distance (px) between the newest turn's top and the viewport's top once
 *  the viewport is at the end and the room is not at its floor. */
export const TURN_TOP_OFFSET = 24;
/** The room's floor (px): the gap left under a turn taller than the
 *  viewport, so streaming text never sits flush against the composer. It is
 *  the transcript's ONLY bottom gap — `session-chat.tsx` adds no bottom
 *  padding under the last turn. */
export const BOTTOM_GAP_PX = 24;
/** Within this many px of the end the reader counts as AT the end (scrollbar
 *  drags and wheel ticks rarely land on the exact pixel). */
export const AT_END_PX = 4;
/** How far from the end (in px of CONTENT, the room excluded) the chevron
 *  appears once the reader has left the end. */
export const CHEVRON_PX = 120;
/** How long after one of our own `scrollTop` writes a `scroll` event still
 *  counts as ours — one frame's slack, since the event lands later. */
export const OWN_SCROLL_MS = 80;
/** A turn-sized move shorter than this is a cut, not a glide — gliding a few
 *  lines reads as lag. */
export const GLIDE_MIN_PX = 80;

/** Pure: is the reader at the end? */
export function isAtEnd(distanceFromEnd: number): boolean {
  return distanceFromEnd <= AT_END_PX;
}

/** Pure: does the chevron show for a reader who is NOT following? */
export function chevronVisible(distanceFromContentEnd: number): boolean {
  return distanceFromContentEnd > CHEVRON_PX;
}

/**
 * Pure: does a `scroll` event mean the viewport left the end for good?
 *
 * Three gates, and every one of them exists because of a real regression:
 *
 * - `ours` — this hook writes `scrollTop` itself on every settle. Reading our
 *   own write as "the reader left" would drop follow the instant it started.
 * - `geometryChanged` — the browser clamps `scrollTop` when the content
 *   shrinks or the viewport grows, and that arrives as a scroll event with no
 *   reader behind it (a composer growing by 24px was the one that used to kill
 *   follow mid-send). A scroll event whose `scrollHeight`/`clientHeight` moved
 *   since the previous one is that clamp, not intent.
 * - `distanceFromEnd` — a scroll that is still AT the end changes nothing.
 *
 * What is left is a viewport that someone else moved away from the end while
 * the layout stood still: find-in-page, an anchor jump, the minimap, an
 * assistive tool, a test driver. Follow yields to it.
 */
export function shouldReleaseFollow(input: {
  following: boolean;
  ours: boolean;
  geometryChanged: boolean;
  distanceFromEnd: number;
}): boolean {
  if (!input.following || input.ours || input.geometryChanged) return false;
  return !isAtEnd(input.distanceFromEnd);
}

export type ScrollKeyIntent = 'up' | 'down' | 'end' | null;

/**
 * Pure: which way a key scrolls the transcript, or null when it does not
 * scroll it.
 *
 * Up is one intent — Cmd+ArrowUp, Ctrl+Home and bare Home all mean "the reader
 * took over" — so modifiers are deliberately not inspected. Down splits in two,
 * because resuming is the direction that can go wrong:
 *   'end'  — End / Cmd+ArrowDown. A discrete, unambiguous "go to the end", the
 *            keyboard form of the chevron, so it goes to the end and follows.
 *   'down' — PageDown / ArrowDown / Space. Ordinary movement: it resumes only
 *            if it actually lands at the end (isAtEnd), like a wheel-down.
 * Alt/Option is excluded: on macOS that is a caret move, not a scroll.
 */
export function classifyScrollKey(event: {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): ScrollKeyIntent {
  if (event.altKey) return null;
  switch (event.key) {
    case 'ArrowUp':
    case 'PageUp':
    case 'Home':
      return 'up';
    case 'End':
      return 'end';
    case 'ArrowDown':
      return event.metaKey ? 'end' : 'down';
    case 'PageDown':
      return 'down';
    case ' ':
    case 'Spacebar':
      return event.shiftKey ? 'up' : 'down';
    default:
      return null;
  }
}

/** Pure: an editable target owns its own caret and its own scrollport, so a
 *  key typed in the composer is never transcript intent. */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return el.closest('[contenteditable="true"], [role="textbox"], [role="combobox"]') !== null;
}

/** Pure: Space activates the focused control instead of scrolling. Every other
 *  scroll key still scrolls while a button holds focus, so only Space is
 *  filtered on this one. */
export function isSpaceActivatedTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return (
    el.closest(
      'button, summary, a[href], [role="button"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="switch"]',
    ) !== null
  );
}

/** Pure: the whole keyboard decision — key plus where focus is. Kept pure so
 *  the matrix (modifiers, editable focus, Space-on-a-button) is testable
 *  without a DOM. */
export function keyScrollIntentFor(event: {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  target: EventTarget | null;
}): ScrollKeyIntent {
  if (isEditableTarget(event.target)) return null;
  const intent = classifyScrollKey(event);
  if (!intent) return null;
  if ((event.key === ' ' || event.key === 'Spacebar') && isSpaceActivatedTarget(event.target)) {
    return null;
  }
  return intent;
}

/** Pure: the room under the anchor turn, given the height from that turn's
 *  top to the end of the content (queued bubbles under it included). */
export function roomUnderNewestTurn(viewportH: number, anchorSpanH: number | null): number {
  if (anchorSpanH === null) return viewportH;
  return Math.max(BOTTOM_GAP_PX, viewportH - anchorSpanH - TURN_TOP_OFFSET);
}

/**
 * Pure: which turn (by DOM order) the room is measured from.
 *
 * The newest turn the agent has reached — a turn marked `data-turn-pending` is
 * not one — else the last turn. `previous` is the anchor the last settle used,
 * with its index looked up again in the CURRENT transcript (-1 once it left
 * it), and whether it was chosen as a reached turn.
 *
 * A reached anchor never falls back to an OLDER turn. Reaching is one-way — the
 * agent does not un-reach a prompt — so a pending mark on the current anchor is
 * a projection that has not caught up (the fresh send's own echo lands before
 * its answer and read as "still queued" for a frame), not a reason to move a
 * whole turn back and forth. A FALLBACK anchor (everything was queued) yields
 * the moment a turn above it is reached, and an anchor that left the transcript
 * (rewind, failed send, session switch) holds nothing.
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

export type SettleMotion = 'none' | 'instant' | 'glide' | 'wait';

/**
 * Pure: how a FOLLOWING viewport gets to the end after a layout change.
 *
 * - in flight (`glideTarget` set): re-aim at a moved end, else let it land.
 *   Never an instant write — that is the cut at the end of a glide.
 * - a whole-turn move (a new anchor, or a send's armed glide) longer than
 *   GLIDE_MIN_PX: glide. A cut there read as "the transcript got wiped".
 * - everything else (text streaming under the anchor): instant — that is the
 *   follow, and a glide there would lag the text.
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

let reducedMotionQuery: MediaQueryList | null | undefined;
export function prefersReducedMotion(): boolean {
  if (reducedMotionQuery === undefined) {
    reducedMotionQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
  }
  return reducedMotionQuery?.matches ?? false;
}
