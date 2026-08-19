'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useAutoScroll — the session transcript's scroll physics, from first
 * principles. Two facts and one rule; nothing else.
 *
 * FACT 1 — the room. Under the newest turn there is always exactly
 *
 *     spacer = max(BOTTOM_GAP_PX, viewportH − newestTurnH − TURN_TOP_OFFSET)
 *
 * of empty space (`spacerElRef`). It is a property of "the newest turn can sit
 * at the top of the screen" — not of "a turn is running" — so it is the same
 * while streaming and when idle, and NOTHING moves when an answer finishes.
 * (Claude.ai.) Recomputed on every content change and viewport resize.
 *
 * FACT 2 — the end. Because of that room, `scrollHeight − clientHeight` IS the
 * newest turn at TURN_TOP_OFFSET while the answer still fits in the room, and
 * the bottom of the answer once it has outgrown it. One position covers both
 * of the old "phases": there is no anchor-vs-follow logic here.
 *
 * THE RULE — follow. `follow` is true when the reader is at the end. While it
 * is true, every layout change (content grew, spacer changed, viewport
 * resized) puts the viewport back at the end, synchronously in the observer
 * callback — so a fresh send lands the new bubble at the top of the screen in
 * the same frame it commits, a streaming answer keeps its tail in view, and a
 * transient block that collapses and re-expands the room cannot leave the turn
 * stranded mid-screen (the re-expansion is just another layout change).
 * `follow` becomes false only on READER intent — a wheel/touch/keyboard scroll
 * up, or a scrollbar drag that leaves the end — and true again when the reader
 * comes back to the end (drag, wheel, chevron) or sends. Programmatic scrolls
 * never count as intent. Nothing here reads "is the session working": if the
 * reader is at the end and something appears, they see it.
 *
 * Direct DOM writes only (`spacer.style.height`, `el.scrollTop`) — never React
 * state on the hot path. The one piece of state is the chevron.
 */

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

/** Pure: is the reader at the end? */
export function isAtEnd(distanceFromEnd: number): boolean {
  return distanceFromEnd <= AT_END_PX;
}

/** Pure: does the chevron show for a reader who is NOT following? */
export function chevronVisible(distanceFromContentEnd: number): boolean {
  return distanceFromContentEnd > CHEVRON_PX;
}

/** Pure: the room under the anchor turn, given the height from that turn's
 *  top to the end of the content (queued bubbles under it included). */
export function roomUnderNewestTurn(viewportH: number, anchorSpanH: number | null): number {
  if (anchorSpanH === null) return viewportH;
  return Math.max(BOTTOM_GAP_PX, viewportH - anchorSpanH - TURN_TOP_OFFSET);
}

interface UseAutoScrollOptions {
  /** True once the scroll area is mounted with content — the refs are null
   *  until then (the area is conditionally rendered), so the observers and
   *  listeners attach on this edge. */
  hasContent?: boolean;
}

interface UseAutoScrollReturn {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  spacerElRef: React.RefObject<HTMLDivElement | null>;
  showScrollButton: boolean;
  /** Go to the end now (instant) and follow from here. */
  scrollToBottom: () => void;
  /** The chevron: glide to the end and follow from here. */
  smoothScrollToAbsoluteBottom: () => void;
  /**
   * A send. Follow from here: the new turn lands at the top of the screen the
   * frame it commits (FACT 2), so this needs no element to exist yet, no
   * retry and no hold — it only has to turn `follow` on and go to the end.
   */
  anchorTurn: (turnId: string) => void;
  /** Open at the TOP and stay there (a sub-session viewed from its start):
   *  turns follow off until the reader comes to the end themselves. */
  startAtTop: () => void;
}

function distanceFromEnd(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

export function useAutoScroll({ hasContent = false }: UseAutoScrollOptions = {}): UseAutoScrollReturn {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerElRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  /** THE RULE's one bit. Starts true: a session opens at its end. */
  const followRef = useRef(true);
  /** The one bit, with its reason, mirrored onto the scroll element as
   *  `data-follow` / `data-follow-why` — readable by e2e assertions and by a
   *  human in devtools, so "why did it stop following?" is never a guess. */
  const setFollow = useCallback((next: boolean, why: string) => {
    followRef.current = next;
    const el = scrollRef.current;
    if (el) {
      el.dataset.follow = String(next);
      el.dataset.followWhy = why;
    }
  }, []);

  /**
   * FACT 1: size the room. The ANCHOR turn is the newest turn the agent has
   * reached — a prompt queued mid-turn (`data-turn-pending`, dimmed) is not
   * it: anchoring on the queued bubble would shift the answer that is still
   * streaming above it out of view. The room is measured from the anchor
   * turn's top to the end of the content, so queued bubbles under it simply
   * take some of that room; the moment the agent reaches one (its pending
   * mark drops) it becomes the anchor and the viewport shifts to it.
   */
  const sizeRoom = useCallback((): number => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const spacer = spacerElRef.current;
    if (!el || !content || !spacer) return 0;
    const turns = content.querySelectorAll<HTMLElement>('[data-turn-id]');
    let anchor: HTMLElement | null = null;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (!turns[i].querySelector('[data-turn-pending]')) {
        anchor = turns[i];
        break;
      }
    }
    if (!anchor && turns.length > 0) anchor = turns[turns.length - 1];
    // The end of the CONTENT is the spacer's own top edge — the spacer lives
    // inside the content box, so measuring to the box's bottom would include
    // the room itself and feed back (room grows → span grows → room shrinks →
    // …, a 400px oscillation every 100ms, observed).
    const span = anchor
      ? spacer.getBoundingClientRect().top - anchor.getBoundingClientRect().top
      : null;
    const h = roomUnderNewestTurn(el.clientHeight, span);
    if (spacer.style.height !== `${h}px`) spacer.style.height = `${h}px`;
    return h;
  }, []);

  /** FACT 2 + THE RULE: after any layout change, a following viewport is at the end. */
  const settle = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    sizeRoom();
    if (!followRef.current) return;
    const end = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - end) > 0.5) el.scrollTop = end;
  }, [sizeRoom]);

  const goToEnd = useCallback(
    (behavior: ScrollBehavior) => {
      const el = scrollRef.current;
      if (!el) return;
      setFollow(true, behavior === 'smooth' ? 'chevron' : 'send');
      setShowScrollButton(false);
      sizeRoom();
      const end = el.scrollHeight - el.clientHeight;
      if (behavior === 'smooth') el.scrollTo({ top: end, behavior: 'smooth' });
      else el.scrollTop = end;
    },
    [sizeRoom, setFollow],
  );

  const scrollToBottom = useCallback(() => goToEnd('auto'), [goToEnd]);
  const smoothScrollToAbsoluteBottom = useCallback(() => goToEnd('smooth'), [goToEnd]);
  const anchorTurn = useCallback(() => goToEnd('auto'), [goToEnd]);
  const startAtTop = useCallback(() => {
    const el = scrollRef.current;
    setFollow(false, 'start-at-top');
    if (el) el.scrollTop = 0;
  }, [setFollow]);

  // ── Layout observers: content + viewport → settle ──────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    // ResizeObserver fires after layout for both the content box (text
    // streamed, a block appeared, an image loaded) and the viewport (panel
    // resized, composer grew). MutationObserver covers DOM changes that do
    // not change the content box's size but move the newest turn (a node
    // swapped for one of equal height) — cheap, and settle() is idempotent.
    let frame = 0;
    const scheduleSettle = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        settle();
      });
    };
    const ro = new ResizeObserver(() => settle());
    ro.observe(content);
    ro.observe(el);
    const mo = new MutationObserver(scheduleSettle);
    mo.observe(content, {
      childList: true,
      subtree: true,
      characterData: true,
      // The anchor turn is chosen by `data-turn-pending` — see `sizeRoom`.
      attributes: true,
      attributeFilter: ['data-turn-pending'],
    });
    settle();
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [settle, hasContent]);

  // ── Reader intent ─────────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const leaveEnd = (why: string) => {
      if (!followRef.current) return;
      setFollow(false, why);
    };
    const updateChevron = () => {
      if (followRef.current) {
        setShowScrollButton(false);
        return;
      }
      const room = spacerElRef.current?.offsetHeight ?? 0;
      setShowScrollButton(chevronVisible(distanceFromEnd(el) - room));
    };
    const maybeResume = (why: string) => {
      if (isAtEnd(distanceFromEnd(el))) {
        setFollow(true, why);
        setShowScrollButton(false);
      }
    };

    // Wheel: up = intent to leave; down = intent, and resumes at the end.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) leaveEnd('wheel-up');
      requestAnimationFrame(() => {
        if (e.deltaY > 0) maybeResume('wheel-down');
        updateChevron();
      });
    };
    // Touch: any move is intent; a downward swipe that reaches the end resumes.
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const dy = touchStartY - (e.touches[0]?.clientY ?? 0);
      if (dy < -6) leaveEnd('touch-up');
      requestAnimationFrame(() => {
        if (dy > 6) maybeResume('touch-down');
        updateChevron();
      });
    };
    // Keyboard scrolling inside the transcript.
    const onKeyDown = (e: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(e.key)) leaveEnd('key-up');
      requestAnimationFrame(() => {
        if (['ArrowDown', 'PageDown', 'End'].includes(e.key)) maybeResume('key-down');
        updateChevron();
      });
    };
    // Scroll: NOT an intent signal. The transcript hides its scrollbar
    // (`scrollbar-hide`), so every reader scroll arrives as wheel, touch or
    // keys above; what reaches this listener is our own writes, the browser
    // clamping scrollTop when content shrinks, and the minimap. Reading any
    // of those as "the reader left" is exactly what used to kill follow at
    // random (a composer shrink clamped scrollTop by 24px in the same frame a
    // send committed). This listener only re-arms follow when the reader has
    // come back to the end, and keeps the chevron honest.
    const onScroll = () => {
      if (!followRef.current && isAtEnd(distanceFromEnd(el))) setFollow(true, 'scroll-to-end');
      updateChevron();
    };
    el.dataset.follow = String(followRef.current);

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('keydown', onKeyDown);
      el.removeEventListener('scroll', onScroll);
    };
  }, [hasContent, setFollow]);

  return {
    scrollRef,
    contentRef,
    spacerElRef,
    showScrollButton,
    scrollToBottom,
    smoothScrollToAbsoluteBottom,
    anchorTurn,
    startAtTop,
  };
}
