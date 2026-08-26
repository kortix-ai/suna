'use client';

import { cn } from '@/lib/utils';
import { useEffect, useRef, useState } from 'react';

/**
 * Containment for a turn wrapper — and the two rules that make it safe.
 *
 * `content-visibility: auto` lets the browser skip layout and paint for a turn
 * that is off screen. That is a real saving here: the transcript grows by a
 * page of 50 messages (~25 turns) on every `loadOlder` pull and never sheds
 * them, so a long session can hold hundreds of turns in the DOM.
 *
 * RULE 1 — a turn stands in at ITS OWN measured height, never at a guess.
 * `contain-intrinsic-size: auto <length>` falls back to `<length>` until the
 * browser has a LAST-REMEMBERED size for the element, and it only records one
 * while the element is laid out WITH the property applied. A turn that is
 * measured off screen and given the property in the same commit is skipped
 * before it can ever record one, so it stands in at the flat guess for as long
 * as it stays off screen. Real turns here are 100-500px, so a flat 600px guess
 * inflated every off-screen turn: the transcript's `scrollHeight` became a
 * function of where the reader was, growing by ~400px per turn scrolled away
 * from and shrinking again as each one came back through the viewport
 * (measured: 40 turns, 20,221px of content at the end of the thread, 12,541px
 * of the SAME turns at the top — the reported "the thread shrinks under me
 * while I scroll back"). So the stand-in is the turn's own measured height,
 * written per turn, and no turn is contained before it has one.
 *
 * RULE 3 — no containment below `TURN_MIN_CONTAIN_PX`. See its own comment:
 * a turn skipped at a near-zero stand-in can never come back.
 *
 * RULE 2 — no containment for an EMPTY turn, ever. A zero-height element can
 * never intersect the viewport, so `content-visibility: auto` classifies it as
 * "not relevant" and SKIPS it — permanently — and a skipped element stands in
 * at its fallback size rather than at 0px. Worse than a static blank block, it
 * oscillates: at the fallback size it intersects the viewport → becomes
 * relevant → un-skips → lays out at its real 0px → stops intersecting → skips
 * → fallback again. Every flip pumps `scrollHeight`, and the transcript's
 * scroll physics (`use-auto-scroll.ts`) re-settle on each one — which the
 * reader experienced as "I scroll down and get teleported back". (Observed
 * with the empty turns a failed compaction leaves behind; the fix is generic
 * because ANY empty turn reproduces it.) An empty turn also drops the spacing
 * its caller gave it, so a run of invisible turns contributes 0px, not a
 * stack of 48px margins.
 */
export type TurnMeasureState = 'unmeasured' | 'empty' | 'measured';

/**
 * The smallest stand-in a turn may be skipped at — RULE 3.
 *
 * `content-visibility: auto` decides relevance from the box the element
 * OCCUPIES, and while skipped that box is the stand-in size. So a turn skipped
 * at a few pixels can never grow back into the viewport on its own: it is too
 * short to intersect, so it is never laid out, so its stand-in is never
 * corrected — the reader gets a run of invisible turns and a scroll container
 * with no extent. That is RULE 2's oscillation with the flip removed, and a
 * height-driven stand-in can reach it where the old flat 600px guess could not
 * (600px always intersected eventually).
 *
 * 48px is below every real turn measured on live threads (101px for a one-line
 * exchange, 138-503px typical) and above the pixel range where skipping saves
 * anything: laying out a sub-48px turn costs nothing worth this failure mode.
 */
export const TURN_MIN_CONTAIN_PX = 48;

/**
 * The stand-in size a skipped turn reports — RULES 1 and 3, as a pure value.
 *
 * `auto` keeps the browser's last-remembered size in charge once it has one;
 * the length after it is the fallback for every frame before that, and it is
 * this turn's own last measured height rather than a shared guess. Undefined
 * whenever the turn must not be contained at all — including a measurement too
 * short to be a credible box, which is the case a stand-in can never recover
 * from.
 */
export function turnIntrinsicSize(
  state: TurnMeasureState,
  measuredHeight: number,
): string | undefined {
  if (state !== 'measured') return undefined;
  if (!(measuredHeight >= TURN_MIN_CONTAIN_PX)) return undefined;
  return `auto ${Math.round(measuredHeight)}px`;
}

/**
 * The wrapper's full class list. Pure and DOM-free so every rule above has a
 * test that can fail:
 *
 * - `unmeasured` → caller classes only (no containment yet — RULE 1).
 * - `empty`      → no containment (RULE 2), and `mt-0` AFTER the caller's
 *                  classes so tailwind-merge drops the caller's `mt-*`.
 * - `measured`   → containment, but ONLY when it has a stand-in to be skipped
 *                  at (RULE 3). The size itself is an inline style, so the
 *                  class is driven by `turnIntrinsicSize` rather than by the
 *                  state: that is what makes "contained" and "has a stand-in"
 *                  the same fact instead of two that can disagree.
 */
export function turnViewportClassName(
  state: TurnMeasureState,
  className?: string,
  measuredHeight = 0,
): string {
  return cn(
    turnIntrinsicSize(state, measuredHeight) !== undefined && '[content-visibility:auto]',
    className,
    state === 'empty' && 'mt-0',
  );
}

/**
 * How long a turn's height must hold still before it is allowed to skip.
 *
 * A turn does not reach its final height in the frame it mounts: markdown
 * renders, code blocks highlight, images decode. Contain it at the height it
 * had one frame in and that number is FROZEN — a skipped subtree is never laid
 * out, so the growth is invisible and the stand-in stays wrong until the turn
 * comes back through the viewport. Measured on a real thread: 25 turns
 * contained a frame after mount stood in at 6,953px and laid out at 12,422px
 * once scrolled through — 5.5k px of content appearing below the reader, which
 * is the same "the thread changes length while I read it" bug as the flat
 * guess, in the other direction.
 *
 * So the height has to hold still first. Half a second is longer than a
 * markdown pass and shorter than a reader's scroll back through a page.
 */
export const TURN_SETTLE_MS = 500;

/**
 * `unmeasured` until the turn has held one height for `TURN_SETTLE_MS`, then
 * `measured`/`empty` by whether it actually has a box — tracked for LIFE, not
 * just once: a turn that later collapses to nothing (its messages render no
 * visible content) must give containment back, or RULE 2's oscillation starts
 * right where it stopped. The height comes back with it, because RULE 1's
 * stand-in is that height.
 *
 * Two nested frames before the first reading: a `requestAnimationFrame`
 * scheduled from a passive effect can still run before the browser has laid
 * out the commit that effect belongs to; the second frame is the point where
 * the layout is guaranteed to have happened. The ResizeObserver then keeps the
 * answer current — including the self-heal that matters most: when a skipped
 * turn comes back on screen it lays out for real, and if that height is not
 * the one we published, the new one replaces it (and the browser records its
 * own last-remembered size from that same layout).
 *
 * Readings are rounded to whole pixels, and a reading equal to the one already
 * published is dropped, so the observer can never loop against its own write:
 * while the turn is skipped it reports the stand-in size, which IS that value.
 */
export function useTurnMeasure(ref: React.RefObject<HTMLDivElement | null>): {
  state: TurnMeasureState;
  height: number;
} {
  const [measure, setMeasure] = useState<{ state: TurnMeasureState; height: number }>({
    state: 'unmeasured',
    height: 0,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let inner = 0;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let ro: ResizeObserver | null = null;
    /** The last height this effect has SEEN, published or still settling. */
    let seen = -1;

    const publish = () => {
      const measured = Math.round(el.offsetHeight);
      const state: TurnMeasureState = measured > 0 ? 'measured' : 'empty';
      setMeasure((prev) => {
        // An empty turn keeps whatever height it last had: it is uncontained
        // either way (RULE 2), and if it fills back in the stand-in is already
        // right instead of being a guess again.
        const height = measured > 0 ? measured : prev.height;
        if (prev.state === state && prev.height === height) return prev;
        return { state, height };
      });
    };
    const read = () => {
      const measured = Math.round(el.offsetHeight);
      if (measured === seen) return; // still the same height — let it settle
      seen = measured;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(publish, TURN_SETTLE_MS);
    };

    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        read();
        ro = new ResizeObserver(read);
        ro.observe(el);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      clearTimeout(settleTimer);
      ro?.disconnect();
    };
  }, [ref]);

  return measure;
}

/**
 * One turn's wrapper: the scroll anchor (`data-turn-id`) plus the containment
 * that `useAutoScroll` and the history-restore path both measure through.
 */
export function TurnViewport({
  turnId,
  className,
  children,
}: {
  turnId: string;
  className?: string;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { state, height } = useTurnMeasure(ref);
  const containIntrinsicSize = turnIntrinsicSize(state, height);

  return (
    <div
      ref={ref}
      data-turn-id={turnId}
      className={turnViewportClassName(state, className, height)}
      style={containIntrinsicSize ? { containIntrinsicSize } : undefined}
    >
      {children}
    </div>
  );
}
