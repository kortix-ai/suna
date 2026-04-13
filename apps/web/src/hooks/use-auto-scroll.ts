'use client';

import { useRef, useEffect, useCallback, useState } from 'react';

/**
 * useAutoScroll — ChatGPT-style scroll.
 *
 * Spacer = max(0, viewportH - lastTurnH - TURN_TOP_OFFSET).
 * Updated via DIRECT DOM manipulation (spacerRef.style.height), not
 * React state. This avoids re-renders that fight with the RAF loop.
 *
 * Key physics: as the last turn grows by X, the spacer shrinks by X.
 * scrollHeight stays CONSTANT. No scrolling is needed while the
 * response fits in the viewport — content fills in where the spacer was.
 * Once the spacer hits 0, scrollHeight grows and the RAF loop follows.
 *
 * MutationObserver recalculates the spacer on every content change.
 * This is now safe because scrollHeight doesn't change (turn growth
 * and spacer shrinkage cancel out), so there's nothing to fight.
 *
 * User scroll intent:
 * Once the user scrolls UP, auto-scroll is disabled and the "scroll to
 * bottom" FAB appears. Auto-scroll resumes ONLY when:
 *   - The user clicks the FAB (scrollToBottom)
 *   - The user sends a new message (scrollToBottom)
 *   - The user scrolls all the way back to the absolute bottom of the
 *     scrollable area (classic scrollHeight check, NOT measureTarget)
 */

/** Max spacer height (px) when the session is idle. Prevents the
 *  ChatGPT-style spacer from filling the viewport with whitespace
 *  when the last turn is short and the session is no longer streaming. */
const IDLE_SPACER_CAP = 120;

interface UseAutoScrollOptions {
  working: boolean;
  /** Whether the scroll container has content. Used to re-attach listeners
   *  when the scroll area mounts (it's conditionally rendered). */
  hasContent?: boolean;
}

interface UseAutoScrollReturn {
  scrollRef: React.RefObject<HTMLDivElement>;
  contentRef: React.RefObject<HTMLDivElement>;
  spacerElRef: React.RefObject<HTMLDivElement>;
  showScrollButton: boolean;
  scrollToBottom: () => void;
  scrollToLastTurn: () => void;
  scrollToEnd: () => void;
  /** Instant scroll to the absolute bottom of the scroll container.
   *  For short responses the spacer keeps the user bubble near the top.
   *  For long responses this shows the end of the AI response. */
  scrollToAbsoluteBottom: () => void;
  /** Same as scrollToAbsoluteBottom but with smooth animation. */
  smoothScrollToAbsoluteBottom: () => void;
}

/** How close to the bottom (px) counts as "at the bottom" for hiding the FAB. */
const BOTTOM_THRESHOLD = 80;

const TURN_TOP_OFFSET = 24;

/** scrollTop that puts the last [data-turn-id] at TURN_TOP_OFFSET from viewport top. */
function measureTarget(scrollEl: HTMLDivElement, contentEl: HTMLDivElement): number | null {
  const turns = contentEl.querySelectorAll<HTMLElement>('[data-turn-id]');
  const last = turns[turns.length - 1];
  if (!last) return null;
  const sr = scrollEl.getBoundingClientRect();
  const tr = last.getBoundingClientRect();
  return Math.max(0, scrollEl.scrollTop + (tr.top - sr.top) - TURN_TOP_OFFSET);
}

/** Classic "near the absolute bottom of scrollable content" check. */
function isNearScrollEnd(el: HTMLDivElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
}

/** Whether the user has scrolled far enough from the bottom to warrant showing the FAB.
 *  Subtracts the spacer height so the threshold is relative to actual content, not the spacer. */
function isFarFromBottom(el: HTMLDivElement, spacerHeight: number): boolean {
  const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight - spacerHeight;
  return distFromBottom >= 300;
}

export function useAutoScroll({ working, hasContent = false }: UseAutoScrollOptions): UseAutoScrollReturn {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerElRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const userScrolledRef = useRef(false);
  const rafIdRef = useRef<number>(0);
  const prevWorkingRef = useRef(working);
  const workingRef = useRef(working);
  workingRef.current = working;
  // Current spacer value for the RAF loop's contentH calculation.
  const spacerValRef = useRef(0);
  // Guard: true while a programmatic scroll (scrollToBottom/scrollToEnd) is
  // in progress.  Prevents the catch-all scroll listener from interpreting
  // intermediate smooth-scroll frames as "user scrolled up".
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimer = useRef<ReturnType<typeof setTimeout>>(0 as any);

  // ── Spacer recalc (direct DOM, no React state) ────────────────────
  const recalcSpacer = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    const spacer = spacerElRef.current;
    if (!el || !content || !spacer) return;

    const vh = el.clientHeight;
    const turns = content.querySelectorAll<HTMLElement>('[data-turn-id]');
    const last = turns[turns.length - 1];
    let h = last
      ? Math.max(0, vh - last.offsetHeight - TURN_TOP_OFFSET)
      : vh;

    // When idle, cap the spacer so short responses don't leave a huge
    // blank area below the conversation.
    if (!workingRef.current) {
      h = Math.min(h, IDLE_SPACER_CAP);
    }

    spacerValRef.current = h;
    spacer.style.height = h + 'px';
  }, []);

  // ── Observers: resize + content mutations ─────────────────────────
  // Re-run when `working` changes so that observers are created once the
  // scroll area actually mounts (it's conditionally rendered — refs may
  // be null on the initial mount during loading/welcome screen).
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;

    let rafId = 0;
    const schedule = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => { rafId = 0; recalcSpacer(); });
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(el);

    const mo = new MutationObserver(schedule);
    mo.observe(content, { childList: true, subtree: true, characterData: true });

    recalcSpacer();

    return () => { ro.disconnect(); mo.disconnect(); cancelAnimationFrame(rafId); };
  }, [recalcSpacer, working, hasContent]);

  // ── isAtBottom (DOM-measured, uses measureTarget) ─────────────────
  const isAtBottom = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return true;
    const target = measureTarget(el, content);
    if (target === null) return true;
    return el.scrollTop >= target - BOTTOM_THRESHOLD;
  }, []);

  // ── Instant scroll: last turn at top ──────────────────────────────
  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    // Ensure spacer is sized before measuring — covers the case where
    // observers haven't been set up yet (e.g. idle session first load).
    recalcSpacer();
    userScrolledRef.current = false;
    setShowScrollButton(false);
    programmaticScrollRef.current = true;
    clearTimeout(programmaticScrollTimer.current);
    const target = measureTarget(el, content);
    if (target !== null) el.scrollTop = target;
    // Release the guard after a frame so the instant scroll settles.
    programmaticScrollTimer.current = setTimeout(() => { programmaticScrollRef.current = false; }, 50);
  }, [recalcSpacer]);

  // ── Smooth scroll: last turn at top ───────────────────────────────
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return;
    // Ensure spacer is sized before measuring.
    recalcSpacer();
    userScrolledRef.current = false;
    setShowScrollButton(false);
    programmaticScrollRef.current = true;
    clearTimeout(programmaticScrollTimer.current);
    const target = measureTarget(el, content);
    if (target !== null) el.scrollTo({ top: target, behavior: 'smooth' });
    // Release the guard after smooth scroll completes (~400ms is typical).
    programmaticScrollTimer.current = setTimeout(() => { programmaticScrollRef.current = false; }, 500);
  }, [recalcSpacer]);

  const scrollToLastTurn = useCallback(() => scrollToBottom(), [scrollToBottom]);

  // ── Absolute-bottom scroll (for initial load / tab switch) ────────
  // Scrolls to scrollHeight - clientHeight. When the last turn fits in
  // the viewport the spacer makes this equivalent to measureTarget.
  // When the last turn overflows the viewport (spacer = 0), this shows
  // the actual end of the conversation instead of the user bubble.
  const scrollToAbsoluteBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    recalcSpacer();
    userScrolledRef.current = false;
    setShowScrollButton(false);
    programmaticScrollRef.current = true;
    clearTimeout(programmaticScrollTimer.current);
    el.scrollTop = el.scrollHeight - el.clientHeight;
    programmaticScrollTimer.current = setTimeout(() => { programmaticScrollRef.current = false; }, 50);
  }, [recalcSpacer]);

  const smoothScrollToAbsoluteBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    recalcSpacer();
    userScrolledRef.current = false;
    setShowScrollButton(false);
    programmaticScrollRef.current = true;
    clearTimeout(programmaticScrollTimer.current);
    el.scrollTo({ top: el.scrollHeight - el.clientHeight, behavior: 'smooth' });
    programmaticScrollTimer.current = setTimeout(() => { programmaticScrollRef.current = false; }, 500);
  }, [recalcSpacer]);

  // ── On working → idle: re-anchor after DOM settles ────────────────
  useEffect(() => {
    const was = prevWorkingRef.current;
    prevWorkingRef.current = working;
    if (was && !working && !userScrolledRef.current) {
      // Spacer is already correct (MO keeps it updated).
      // Re-anchor to the absolute bottom so the user sees the end of
      // the response (for long responses) or the user bubble (for short
      // ones where the spacer fills the gap).
      const t1 = setTimeout(scrollToAbsoluteBottom, 100);
      const t2 = setTimeout(scrollToAbsoluteBottom, 500);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    }
  }, [working, scrollToAbsoluteBottom]);

  // ── RAF auto-scroll during streaming ──────────────────────────────
  // Phase 1 (spacer > 0): scrollHeight is constant, no scrolling needed.
  //   The spacer shrinks as the turn grows — content fills in naturally.
  // Phase 2 (spacer = 0): scrollHeight grows. Follow the growth.
  useEffect(() => {
    if (!working) {
      // Not streaming — calculate spacer once (covers idle session loads
      // where the observer setup may have been deferred).
      recalcSpacer();
      const timer = setTimeout(() => {
        const el = scrollRef.current;
        if (el && isFarFromBottom(el, spacerValRef.current)) setShowScrollButton(true);
        else setShowScrollButton(false);
      }, 400);
      return () => clearTimeout(timer);
    }

    let active = true;

    const tick = () => {
      if (!active) return;
      const el = scrollRef.current;
      if (el && !userScrolledRef.current) {
        // Safety guard: if we're no longer near the end, stop auto-follow.
        // This catches cases where wheel/touch intent didn't get captured
        // (e.g. nested scrollable content consuming the gesture).
        if (!isNearScrollEnd(el)) {
          userScrolledRef.current = true;
          if (isFarFromBottom(el, spacerValRef.current)) {
            setShowScrollButton(true);
          }
        }
        // Only scroll when the spacer has hit 0 and content overflows.
        const contentH = el.scrollHeight - spacerValRef.current;
        const viewportBottom = el.scrollTop + el.clientHeight;
        const overflow = contentH - viewportBottom;
        if (!userScrolledRef.current && overflow > 0) {
          el.scrollTop += overflow;
        }
      }
      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);
    return () => { active = false; cancelAnimationFrame(rafIdRef.current); };
  }, [working, hasContent, isAtBottom, recalcSpacer]);

  // ── Wheel intent ──────────────────────────────────────────────────
  // Depends on `working`/`hasContent` so listeners are (re-)attached
  // when the scroll area mounts (it's conditionally rendered).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handle = (e: WheelEvent) => {
      if (e.deltaY !== 0) {
        // Any wheel intent means the user is trying to control scroll.
        // Immediately pause RAF follow so it never fights manual scrolling
        // (trackpads can report inverted/ambiguous delta signs).
        userScrolledRef.current = true;
        requestAnimationFrame(() => {
          if (isFarFromBottom(el, spacerValRef.current)) {
            setShowScrollButton(true);
          }
        });
      }
      if (e.deltaY > 0) {
        // Resume only when the user has manually reached absolute bottom.
        requestAnimationFrame(() => {
          if (isNearScrollEnd(el)) {
            userScrolledRef.current = false;
            setShowScrollButton(false);
          }
        });
      }
    };
    el.addEventListener('wheel', handle, { passive: true });
    return () => el.removeEventListener('wheel', handle);
  }, [working, hasContent]);

  // ── Touch intent ──────────────────────────────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let startY = 0;
    const onStart = (e: TouchEvent) => { startY = e.touches[0]?.clientY ?? 0; };
    const onMove = (e: TouchEvent) => {
      const dy = startY - (e.touches[0]?.clientY ?? 0);
      if (Math.abs(dy) > 6) {
        // Any touch move intent should pause RAF follow so the user can
        // freely scroll while streaming.
        userScrolledRef.current = true;
        requestAnimationFrame(() => {
          if (isFarFromBottom(el, spacerValRef.current)) {
            setShowScrollButton(true);
          }
        });
      }
      if (dy > 10) {
        // Swiping down → resume only at absolute bottom
        requestAnimationFrame(() => {
          if (isNearScrollEnd(el)) {
            userScrolledRef.current = false;
            setShowScrollButton(false);
          }
        });
      }
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: true });
    return () => { el.removeEventListener('touchstart', onStart); el.removeEventListener('touchmove', onMove); };
  }, [working, hasContent]);

  // ── Keyboard / scrollbar drag catch-all ───────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let last = el.scrollTop;
    const handle = () => {
      const cur = el.scrollTop;
      // Detect upward scroll (keyboard, scrollbar drag) — but ignore
      // intermediate frames from programmatic smooth-scrolls.
      // Only show FAB if far enough from bottom.
      if (cur < last - 2 && !programmaticScrollRef.current) {
        // Immediately suppress auto-scroll on any upward scroll.
        // Show FAB only if far enough from the bottom.
        userScrolledRef.current = true;
        if (isFarFromBottom(el, spacerValRef.current)) {
          setShowScrollButton(true);
        }
      }
      last = cur;
    };
    el.addEventListener('scroll', handle, { passive: true });
    return () => el.removeEventListener('scroll', handle);
  }, [working, hasContent]);

  return { scrollRef, contentRef, spacerElRef, showScrollButton, scrollToBottom, scrollToLastTurn, scrollToEnd, scrollToAbsoluteBottom, smoothScrollToAbsoluteBottom };
}
