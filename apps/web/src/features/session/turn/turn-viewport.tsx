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
 * RULE 1 — no skipping before a real layout. `contain-intrinsic-size:
 * auto <length>` uses the turn's LAST-REMEMBERED rendered size — but a turn
 * only earns one by being laid out at least once while it is NOT skipping. A
 * session opens scrolled to the end, so on a fresh load every turn above the
 * reader has never been laid out, and every one of them would stand in at the
 * flat 600px guess; scrolling up, each correction lands ABOVE the viewport and
 * throws the reader to a random place. So a turn gets no containment until it
 * has been through one real layout.
 *
 * RULE 2 — no containment for an EMPTY turn, ever. A zero-height element can
 * never intersect the viewport, so `content-visibility: auto` classifies it as
 * "not relevant" and SKIPS it — permanently — and a skipped element with no
 * last-remembered size stands in at the 600px guess. Worse than a static
 * blank block, it oscillates: at 600px it intersects the viewport → becomes
 * relevant → un-skips → lays out at its real 0px → stops intersecting → skips
 * → 600px again. Every flip pumps `scrollHeight` by 600px, and the transcript's
 * scroll physics (`use-auto-scroll.ts`) re-settle on each one — which the
 * reader experienced as "I scroll down and get teleported back". (Observed
 * with the empty turns a failed compaction leaves behind; the fix is generic
 * because ANY empty turn reproduces it.) An empty turn also drops the spacing
 * its caller gave it, so a run of invisible turns contributes 0px, not a
 * stack of 48px margins.
 */
export type TurnMeasureState = 'unmeasured' | 'empty' | 'measured';

/**
 * The wrapper's full class list for a given measure state. Pure and DOM-free
 * so both rules above have tests that can fail:
 *
 * - `unmeasured` → caller classes only (no containment yet — RULE 1).
 * - `empty`      → no containment (RULE 2), and `mt-0` AFTER the caller's
 *                  classes so tailwind-merge drops the caller's `mt-*`.
 * - `measured`   → containment, with an intrinsic size it can now honour.
 */
export function turnViewportClassName(state: TurnMeasureState, className?: string): string {
  return cn(
    state === 'measured' && '[contain-intrinsic-size:auto_600px] [content-visibility:auto]',
    className,
    state === 'empty' && 'mt-0',
  );
}

/**
 * `unmeasured` until the turn has been through one real layout, then
 * `measured`/`empty` by whether it actually has a box — tracked for LIFE, not
 * just once: a turn that later collapses to nothing (its messages render no
 * visible content) must give containment back, or RULE 2's oscillation starts
 * right where it stopped.
 *
 * Two nested frames before the first reading, same as always: a
 * `requestAnimationFrame` scheduled from a passive effect can still run before
 * the browser has laid out the commit that effect belongs to; the second frame
 * is the point where the layout is guaranteed to have happened. The
 * ResizeObserver then keeps the answer current — it fires only on real size
 * changes, and `setState` to the same value is a React no-op, so steady state
 * costs nothing.
 *
 * (While `measured` and skipped, the element reports its stand-in size — its
 * remembered size, never 0 — so a skip alone can never flip the state back to
 * `empty`. Only a real re-layout at zero height can.)
 */
export function useTurnMeasureState(ref: React.RefObject<HTMLDivElement | null>): TurnMeasureState {
  const [state, setState] = useState<TurnMeasureState>('unmeasured');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let inner = 0;
    let ro: ResizeObserver | null = null;
    const measure = () => setState(el.offsetHeight > 0 ? 'measured' : 'empty');
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        measure();
        ro = new ResizeObserver(measure);
        ro.observe(el);
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
      ro?.disconnect();
    };
  }, [ref]);

  return state;
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
  const measureState = useTurnMeasureState(ref);

  return (
    <div ref={ref} data-turn-id={turnId} className={turnViewportClassName(measureState, className)}>
      {children}
    </div>
  );
}
