'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * Height (px) a collapsed body is held at.
 *
 * Deliberately a number rather than a `max-h-[18rem]` class: the same value has
 * to be the *start* of the expand transition, and `max-height: auto` does not
 * animate. The end of that transition is a measured pixel height, so the start
 * has to be a pixel height too or the two ends aren't interpolatable and the
 * panel snaps open instead of growing.
 */
export const COLLAPSED_MAX_HEIGHT = 288;

/**
 * Vertical room reserved under the content for the toggle when open.
 *
 * The toggle is absolutely positioned so it holds the same spot in both states
 * (`bottom-4`, centred). When collapsed it sits over the fade, which is over
 * clipped content — nothing to protect. When open there is no fade, so the
 * content needs real padding beneath it or the label lands on the last line.
 * Tailwind's preflight sets `box-sizing: border-box`, so this padding is inside
 * `maxHeight` and has to be added to the measured height, not left implicit.
 */
const CONTROL_ROOM = 48;

/** Slack under the clamp before a body counts as long enough to be worth expanding. */
const OVERFLOW_SLACK = 4;

/**
 * Fold a fresh measurement into the retained one — or reject it.
 *
 * A measured height of `0` does NOT mean "the content is empty". Every turn in
 * the transcript is `content-visibility: auto` (`session-chat.tsx`), so the
 * browser skips layout for a turn that is off screen, and both
 * `getBoundingClientRect()` and `ResizeObserver` report a zero-size box for
 * anything inside a skipped subtree. Writing that zero into state is what made
 * an OPEN block silently shut itself the moment it scrolled out of view:
 * `canExpand` fell to `false`, `maxHeight` snapped back to the clamp, the
 * document lost however many hundreds of pixels the block was holding, and
 * every turn below it moved under the reader.
 *
 * Retaining the last real measurement fixes a second, quieter problem too. The
 * toggle and the fade are gated on `canExpand`, so a zero also unmounted them
 * on the way out and remounted them on the way back — a `childList` mutation
 * inside the transcript on every crossing, which the auto-scroll
 * `MutationObserver` (`use-auto-scroll.ts`) answers with a spacer recalc. Held
 * steady, the measurement stops changing after the first real read, React bails
 * out of the identical `setState`, and scrolling past a command output mutates
 * nothing at all.
 *
 * DOM-free on purpose, in the spirit of `turn-anchor.ts`: the caller is a
 * `ResizeObserver`, and effects never commit under `renderToStaticMarkup` — the
 * only render this app can test. Keeping the decision here is what lets the
 * zero-height case have a test that can fail.
 */
export function nextContentHeight(previous: number, measured: number): number {
  if (!Number.isFinite(measured) || measured <= 0) return previous;
  // Ceil rather than round: the value becomes a `max-height`, and rounding down
  // a fractional layout would clip the final line by a fraction of a pixel.
  // Integers also keep sub-pixel jitter from re-rendering on every observation.
  return Math.ceil(measured);
}

/**
 * The clamp, the fade, and the toggle — the parts that differ between the
 * collapsed and expanded states.
 *
 * Split out of {@link ExpandableOutput} and taking `canExpand` as a PROP rather
 * than measuring it, for the same reason `UserMessageBubble` does (see the note
 * on that component): the measurement is a `ResizeObserver`, and the only render
 * this app can test is `renderToStaticMarkup`, where effects never commit. Fold
 * the measurement in here and `canExpand` is permanently `false` under test, so
 * the fade and the toggle are unreachable markup and every assertion about them
 * passes whatever they contain. This seam is what makes them able to fail.
 */
export function ExpandableRegion({
  canExpand,
  expanded,
  onToggle,
  contentRef,
  contentHeight,
  collapsedMaxHeight = COLLAPSED_MAX_HEIGHT,
  fadeClassName = 'from-secondary',
  expandLabel = 'Expand',
  collapseLabel = 'Collapse',
  className,
  contentClassName,
  children,
}: {
  /** The body overflows its clamp, so there is something to expand. */
  canExpand: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** Measured by the container; the clamp animates to this height plus {@link CONTROL_ROOM}. */
  contentRef?: React.RefObject<HTMLDivElement | null>;
  contentHeight: number;
  collapsedMaxHeight?: number;
  /** Gradient origin — must match the surface the panel sits on (`from-secondary`, …). */
  fadeClassName?: string;
  expandLabel?: string;
  collapseLabel?: string;
  className?: string;
  /** Padding/typography for the body. Kept off the clamp so the fade spans edge to edge. */
  contentClassName?: string;
  children?: React.ReactNode;
}) {
  const regionId = useId();
  const open = canExpand && expanded;
  // A height of 0 is the pre-measurement state, not a real reading — see
  // `nextContentHeight`.
  const measured = contentHeight > 0;

  /*
   * Three states, and the order they are resolved in matters:
   *
   * 1. Open — the measured height plus room for the toggle.
   * 2. Measured and too short to expand — NO clamp. A body between the clamp
   *    and the `OVERFLOW_SLACK` threshold (289–292px) is not expandable, so
   *    clamping it would shave a few pixels off the last line with no
   *    affordance anywhere to get them back. Nothing may be hidden that the
   *    reader cannot reveal.
   * 3. Anything else, including every render before the measurement lands —
   *    the clamp. Defaulting to clamped rather than to open is what stops a
   *    long body rendering full-height for the frame before it is measured.
   */
  const maxHeight = open
    ? contentHeight + CONTROL_ROOM
    : measured && !canExpand
      ? undefined
      : collapsedMaxHeight;

  return (
    <div className={cn('relative', className)}>
      {/* The clamp. Collapsed is the default and the only state the reader does
          not choose: `expanded` starts false in `ExpandableOutput` and the
          toggle's onClick is its only writer, so nothing here ever opens on its
          own. */}
      <div
        id={regionId}
        className={cn(
          'overflow-hidden transition-[max-height] duration-300 ease-[cubic-bezier(0.2,0,0,1)]',
          'motion-reduce:transition-none',
          open && 'pb-12',
        )}
        style={{ maxHeight }}
      >
        <div ref={contentRef} className={cn('min-w-0', contentClassName)}>
          {children}
        </div>
      </div>

      {canExpand && (
        <>
          {/* Cross-faded on opacity rather than unmounted, so it dissolves over
              the same 300ms the clamp grows. Unmounting it would cut the fade
              on frame one and leave the body visibly snapping to full contrast
              while it is still mid-height. */}
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t to-transparent',
              'transition-opacity duration-300 ease-[cubic-bezier(0.2,0,0,1)]',
              'motion-reduce:transition-none',
              fadeClassName,
              open ? 'opacity-0' : 'opacity-100',
            )}
          />

          <Button
            type="button"
            variant="transparent"
            size="sm"
            aria-expanded={open}
            aria-controls={regionId}
            onClick={onToggle}
            className={cn(
              'absolute bottom-4 left-1/2 z-10 -translate-x-1/2 px-4',
              'text-muted-foreground hover:text-foreground',
              // Explicit properties, never `transition-all` — and `scale` is its
              // own CSS property in Tailwind v4, so the press does not cancel
              // the `-translate-x-1/2` that centres the button.
              'transition-[color,scale] active:scale-[0.96]',
            )}
          >
            {open ? collapseLabel : expandLabel}
          </Button>
        </>
      )}
    </div>
  );
}

/**
 * A body that clamps to {@link COLLAPSED_MAX_HEIGHT}, fades out at the bottom,
 * and opens from a centred `Expand` toggle sitting on that fade.
 *
 * Measures the content box instead of comparing `scrollHeight` to `clientHeight`
 * because one number has to do two jobs: decide whether the affordance appears
 * at all, and give the clamp a concrete pixel height to animate to. A
 * `ResizeObserver` keeps it correct when late work changes the height — web
 * fonts landing, a markdown image decoding, the column being resized.
 */
export function ExpandableOutput({
  collapsedMaxHeight = COLLAPSED_MAX_HEIGHT,
  fadeClassName,
  expandLabel,
  collapseLabel,
  className,
  contentClassName,
  children,
}: {
  collapsedMaxHeight?: number;
  fadeClassName?: string;
  expandLabel?: string;
  collapseLabel?: string;
  className?: string;
  contentClassName?: string;
  children?: React.ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [contentHeight, setContentHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;

    // Functional update, so an unchanged height is the SAME value and React
    // bails out of the render entirely — see `nextContentHeight` for why a
    // zero-height observation has to be rejected rather than stored.
    const measure = () => {
      const observed = el.getBoundingClientRect().height;
      setContentHeight((previous) => nextContentHeight(previous, observed));
    };

    // First read after the next frame, so layout has settled.
    const rafId = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  const canExpand = contentHeight > collapsedMaxHeight + OVERFLOW_SLACK;
  const toggle = useCallback(() => setExpanded((v) => !v), []);

  return (
    <ExpandableRegion
      canExpand={canExpand}
      // Gated on `canExpand` so a body that shrinks below the clamp while open
      // cannot leave a stale `expanded` behind, holding `maxHeight` at a height
      // the content no longer fills.
      expanded={canExpand && expanded}
      onToggle={toggle}
      contentRef={contentRef}
      contentHeight={contentHeight}
      collapsedMaxHeight={collapsedMaxHeight}
      fadeClassName={fadeClassName}
      expandLabel={expandLabel}
      collapseLabel={collapseLabel}
      className={className}
      contentClassName={contentClassName}
    >
      {children}
    </ExpandableRegion>
  );
}
