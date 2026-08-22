'use client';

import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';

/**
 * Containment for a turn wrapper — and the one rule that makes it safe.
 *
 * `content-visibility: auto` lets the browser skip layout and paint for a turn
 * that is off screen. That is a real saving here: the transcript grows by a
 * page of 50 messages (~25 turns) on every `loadOlder` pull and never sheds
 * them, so a long session can hold hundreds of turns in the DOM.
 *
 * The hazard is what a skipped turn claims to be tall. `contain-intrinsic-size:
 * auto <length>` uses the turn's LAST-REMEMBERED rendered size — but a turn only
 * earns one by being laid out at least once while it is NOT skipping. A session
 * opens scrolled to the end (`session-chat.tsx` sets `scrollTop` to the bottom
 * on mount), so on a fresh load every turn above the reader has never been laid
 * out, and every one of them is standing in at the flat 600px guess.
 *
 * Scrolling UP, each turn crossing into the render zone snaps from 600px to its
 * real height — a turn with a long command output or a big tool block is
 * thousands of pixels, a short one is ~150. That correction lands ABOVE the
 * viewport, so it drags everything below it, including the reader. The error is
 * signed differently per turn, which is why it reads as being thrown to a random
 * place rather than as a consistent drift.
 *
 * Scroll anchoring is what normally absorbs a size change above the viewport,
 * and it structurally cannot help here: an anchor node has to have a box, and a
 * skipped subtree has none.
 *
 * Hence the rule below — a turn does not get to skip until it has been laid out
 * once:
 *
 * - `false` → no containment at all. The turn lays out normally and the browser
 *   records its real size.
 * - `true`, one frame later → containment, with an intrinsic size that is now
 *   EXACT. Every later skip/unskip cycle is a no-op for layout, and the reader
 *   never moves.
 *
 * The flip itself cannot jump, because the remembered size a turn skips to is
 * the size it already occupies. The cost is one ordinary layout per turn at
 * mount — bounded by the page size, paid once, and the same layout the browser
 * would have done anyway the first time the reader scrolled that far.
 *
 * Pure and DOM-free so this decision has a test that can fail: the flag comes
 * from a mount effect, and effects never commit under `renderToStaticMarkup` —
 * the only render this app can test.
 */
export function turnContainmentClass(laidOutOnce: boolean): string {
  return laidOutOnce ? '[contain-intrinsic-size:auto_600px] [content-visibility:auto]' : '';
}

/**
 * False until the turn has been through one real layout, then true forever.
 *
 * Two nested frames, not one. A `requestAnimationFrame` scheduled from a passive
 * effect can still run before the browser has laid out and painted the commit
 * that effect belongs to; the second frame is the point where the layout is
 * guaranteed to have happened. Flipping early would hand the turn to
 * `content-visibility` with no remembered size — which is the exact bug this
 * exists to prevent, and it would fail silently, since a 600px guess looks like
 * a working page right up until the reader scrolls into it.
 */
export function useLaidOutOnce(enabled = true): boolean {
  const [laidOutOnce, setLaidOutOnce] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setLaidOutOnce(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [enabled]);

  return laidOutOnce;
}

/**
 * One turn's wrapper: the scroll anchor (`data-turn-id`) plus the containment
 * that `useAutoScroll` and the history-restore path both measure through.
 *
 * `contain` is off in the VIRTUAL list (`session-timeline-list.tsx`): a turn
 * there is rendered only while it is in or near the viewport and is measured
 * by a ResizeObserver; an overscan turn positioned off screen under
 * `content-visibility: auto` would be layout-skipped and report the 600px
 * stand-in, which would become its virtual size. The virtualizer IS the
 * containment in that mode. The flat list keeps the rule above.
 */
export function TurnViewport({
  turnId,
  className,
  contain = true,
  children,
}: {
  turnId: string;
  className?: string;
  contain?: boolean;
  children?: React.ReactNode;
}) {
  const laidOutOnce = useLaidOutOnce(contain);

  return (
    <div
      data-turn-id={turnId}
      className={cn(contain && turnContainmentClass(laidOutOnce), className)}
    >
      {children}
    </div>
  );
}
