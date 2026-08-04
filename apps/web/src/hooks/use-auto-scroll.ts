'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createTurnAnchor } from '@/features/session/turn-anchor';

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
  scrollRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  spacerElRef: React.RefObject<HTMLDivElement | null>;
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
  /**
   * Anchor a SPECIFIC turn at the top of the viewport, as soon as it exists.
   *
   * Replaces the send path's `scrollToBottom(); setTimeout(…, 100)` pair, whose
   * own comment admitted it fired "after the turn likely rendered". Both calls
   * happened at send time and targeted "the last `[data-turn-id]`", so before
   * the new turn committed they anchored the PREVIOUS one. See `turn-anchor.ts`.
   */
  anchorTurn: (turnId: string) => void;
}

/** How close to the bottom (px) counts as "at the bottom" for hiding the FAB. */
const BOTTOM_THRESHOLD = 80;

const TURN_TOP_OFFSET = 24;

/**
 * The transcript's TRUE final turn, or null when it is not mounted.
 *
 * Deliberately not `querySelectorAll('[data-turn-id]')` then taking the last
 * one. A windowed transcript only mounts turns near the viewport, so the last
 * node in the DOM is the last *mounted* turn — which is the real final turn
 * only while the reader is at the tail. Sizing the spacer from a mid-thread
 * turn moves scrollHeight underneath the reader.
 *
 * `data-last-turn` is set on the final index by both render paths, so its
 * absence is meaningful: the tail is not mounted, and callers should fall
 * back rather than measure the wrong element.
 */
function findLastTurn(contentEl: HTMLDivElement): HTMLElement | null {
  return contentEl.querySelector<HTMLElement>('[data-last-turn]');
}

/** Whether any turn at all is mounted — distinguishes "empty thread" from
 *  "windowed and scrolled away from the tail". */
function hasMountedTurn(contentEl: HTMLDivElement): boolean {
  return !!contentEl.querySelector('[data-turn-id]');
}

/** scrollTop that puts the last turn at TURN_TOP_OFFSET from viewport top.
 *  Null when the final turn is not mounted — callers must handle that. */
function measureTarget(scrollEl: HTMLDivElement, contentEl: HTMLDivElement): number | null {
  const last = findLastTurn(contentEl);
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

/**
 * Grace period (ms) before the scroll physics accept a working → idle flip.
 * The busy signal hands off across sources (optimistic send → server busy
 * status → stream events) and can flap false for a few hundred ms right as
 * the assistant starts answering. Reacting instantly collapses the spacer
 * (IDLE_SPACER_CAP) + fires the idle re-anchor — yanking the freshly-anchored
 * user bubble to the bottom of the screen. Only scroll behavior is debounced;
 * the caller's loader visuals use the raw signal.
 */
const WORKING_IDLE_GRACE_MS = 1500;

export function useAutoScroll({
  working: workingRaw,
  hasContent = false,
}: UseAutoScrollOptions): UseAutoScrollReturn {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const spacerElRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Sticky working: true edges apply immediately; false edges only after the
  // grace period, so a mid-handoff flap never disturbs the scroll position.
  const [working, setWorking] = useState(workingRaw);
  const idleGraceTimerRef = useRef<ReturnType<typeof setTimeout>>(0 as any);
  // True once anything has streamed while this view is mounted. After that,
  // idle keeps the FULL spacer (last turn stays anchored at top, whitespace
  // below — ChatGPT style); the idle cap only applies to fresh loads of an
  // existing conversation, where trailing whitespace would just look broken.
  const hadStreamedRef = useRef(false);
  useEffect(() => {
    if (workingRaw) {
      clearTimeout(idleGraceTimerRef.current);
      hadStreamedRef.current = true;
      setWorking(true);
      return;
    }
    idleGraceTimerRef.current = setTimeout(() => setWorking(false), WORKING_IDLE_GRACE_MS);
    return () => clearTimeout(idleGraceTimerRef.current);
  }, [workingRaw]);

  const userScrolledRef = useRef(false);
  const rafIdRef = useRef<number>(0);
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
    const last = findLastTurn(content);
    // Windowed transcript with the reader scrolled away from the tail: the
    // true final turn is unmounted. Recomputing from whatever happens to be
    // mounted would size the spacer from a mid-thread turn, and the spacer is
    // real layout at the bottom of the content — so scrollHeight would move
    // under the reader every time the window shifts mid-scroll. Keep the
    // current value instead: a stale spacer is stable, a wrong one moves the
    // page. `hasMountedTurn` distinguishes this from an empty thread, which
    // still legitimately wants a full-viewport spacer.
    if (!last && hasMountedTurn(content)) return;
    let h = last ? Math.max(0, vh - last.offsetHeight - TURN_TOP_OFFSET) : vh;

    // Cap the spacer ONLY on fresh loads of an existing conversation (no
    // streaming yet this mount) — there the whitespace would look broken.
    // Once a turn has streamed, the full spacer persists through idle so the
    // completed turn stays anchored at the top instead of the whole
    // conversation dropping to the bottom of the screen.
    if (!workingRef.current && !hadStreamedRef.current) {
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
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        recalcSpacer();
      });
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(el);

    const mo = new MutationObserver(schedule);
    mo.observe(content, { childList: true, subtree: true, characterData: true });

    recalcSpacer();

    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(rafId);
    };
  }, [recalcSpacer, working, hasContent]);

  // ── isAtBottom (DOM-measured, uses measureTarget) ─────────────────
  const isAtBottom = useCallback(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content) return true;
    const target = measureTarget(el, content);
    if (target === null) {
      // Windowed and scrolled away from the tail — the final turn is not
      // mounted, so it cannot be measured. Returning `true` here would claim
      // we are at the bottom while the reader is mid-thread, which hides the
      // scroll-to-bottom button and re-enables auto-follow. Fall back to the
      // classic check. With no turns at all, `true` is still right.
      return hasMountedTurn(content) ? isNearScrollEnd(el) : true;
    }
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
    // Null means the final turn is unmounted (windowed, scrolled up). Jump to
    // the absolute bottom instead of doing nothing; that mounts the tail, and
    // the follow-up recalc then parks it precisely.
    el.scrollTop = target ?? el.scrollHeight - el.clientHeight;
    // Release the guard after a frame so the instant scroll settles.
    programmaticScrollTimer.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 50);
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
    // Same fallback as scrollToEnd: an unmounted tail must still be reachable.
    el.scrollTo({
      top: target ?? el.scrollHeight - el.clientHeight,
      behavior: 'smooth',
    });
    // Release the guard after smooth scroll completes (~400ms is typical).
    programmaticScrollTimer.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 500);
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
    programmaticScrollTimer.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 50);
  }, [recalcSpacer]);

  // ── Anchor a specific turn once it lands ──────────────────────────────
  // The DOM lives here; the retry/cancel lifecycle lives in `turn-anchor.ts`
  // where it can be tested without a browser.
  const anchorer = useMemo(
    () =>
      createTurnAnchor<HTMLElement>({
        find: (turnId) =>
          contentRef.current?.querySelector<HTMLElement>(
            `[data-turn-id="${CSS.escape(turnId)}"]`,
          ) ?? null,
        anchor: (element) => {
          const el = scrollRef.current;
          if (!el) return;
          recalcSpacer();
          userScrolledRef.current = false;
          setShowScrollButton(false);
          programmaticScrollRef.current = true;
          clearTimeout(programmaticScrollTimer.current);
          const top = Math.max(
            0,
            el.scrollTop +
              (element.getBoundingClientRect().top - el.getBoundingClientRect().top) -
              TURN_TOP_OFFSET,
          );
          el.scrollTo({ top, behavior: 'auto' });
          programmaticScrollTimer.current = setTimeout(() => {
            programmaticScrollRef.current = false;
          }, 50);
        },
        schedule: (fn) => {
          const id = requestAnimationFrame(fn);
          return () => cancelAnimationFrame(id);
        },
      }),
    [recalcSpacer],
  );

  const anchorTurn = useCallback((turnId: string) => anchorer.request(turnId), [anchorer]);

  // The reader taking over outranks a pending anchor. Without this, an anchor
  // queued at send time fires into a viewport they have since scrolled away —
  // which is the "it randomly just shot me up" report.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = () => anchorer.abandon();
    const onTouch = () => anchorer.abandon();
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', onTouch, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', onTouch);
    };
  }, [anchorer, working, hasContent]);

  const smoothScrollToAbsoluteBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    recalcSpacer();
    userScrolledRef.current = false;
    setShowScrollButton(false);
    programmaticScrollRef.current = true;
    clearTimeout(programmaticScrollTimer.current);
    el.scrollTo({ top: el.scrollHeight - el.clientHeight, behavior: 'smooth' });
    programmaticScrollTimer.current = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 500);
  }, [recalcSpacer]);

  // On working → idle: deliberately NO re-anchor. The spacer keeps its full
  // height (see recalcSpacer), so the completed turn stays exactly where it
  // was — user bubble + response anchored at the top, whitespace below. For
  // long responses the RAF loop already followed growth to the end while
  // streaming. Re-anchoring to the absolute bottom here is what used to yank
  // the whole conversation to the bottom of the screen on completion.

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
    return () => {
      active = false;
      cancelAnimationFrame(rafIdRef.current);
    };
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
    const onStart = (e: TouchEvent) => {
      startY = e.touches[0]?.clientY ?? 0;
    };
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
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
    };
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

  return {
    scrollRef,
    contentRef,
    spacerElRef,
    showScrollButton,
    scrollToBottom,
    scrollToLastTurn,
    scrollToEnd,
    scrollToAbsoluteBottom,
    smoothScrollToAbsoluteBottom,
    anchorTurn,
  };
}
