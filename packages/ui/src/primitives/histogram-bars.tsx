'use client';

/**
 * The bar strip and hover card of a time histogram, shared by the Models page
 * Logs histogram (`LogHistogram`) and the trigger Runs histogram
 * (`RunHistogram`). The caller draws each bar and the card's content; this
 * owns the hover behaviour:
 *
 * - The bar highlight follows the pointer at once (CSS `group-hover/bar`).
 * - The hovered bucket is debounced (70 ms), so a sweep across the bars does
 *   not rebuild the card on every bar it crosses.
 * - The card is ONE element. It moves between buckets by `translateX`,
 *   clamped so it never leaves the strip, and fades in with a 4 px y nudge.
 *   Opening from hidden does not slide from the last bucket. Reduced motion:
 *   opacity only.
 * - The card hides only when the pointer leaves the chart (or focus leaves
 *   it). Moving between bars never hides it: it slides by `translateX` (+X
 *   right, −X left), and a CSS transition retargets mid-slide. Re-entering
 *   fades it in at the bar, with no slide from the old spot.
 * - A first hover on an empty bucket opens nothing; an open card passing over
 *   one stays and shows the caller's one-line empty content.
 * - Keyboard focus on a bar opens the same card.
 *
 * Motion: 150 ms (`--duration-normal`) on `--ease-default`, transform and
 * opacity only (animations-dev: tooltips 125–200 ms, ease-out family).
 */

import { useDebounce } from '../hooks/use-debounce';
import { cn } from '../lib/utils';
import { type ReactNode, useEffect, useRef, useState } from 'react';

/** How long the pointer has to rest on a bucket before the card follows it. */
const HOVER_DEBOUNCE_MS = 70;

/**
 * The card's left offset in px: centred on bar `index` of `count` equal bars,
 * clamped to `[0, stripWidth - cardWidth]` so it never clips at an edge.
 */
export function histogramCardOffset(
  index: number,
  count: number,
  stripWidth: number,
  cardWidth: number,
): number {
  if (count < 1 || stripWidth <= 0) return 0;
  const centre = ((index + 0.5) / count) * stripWidth;
  const max = Math.max(0, stripWidth - cardWidth);
  return Math.min(max, Math.max(0, centre - cardWidth / 2));
}

/** Where the hover card is and whether it is out. */
export interface CardState {
  visible: boolean;
  /** The bucket it shows; kept while it fades out. */
  index: number | null;
  /** Animate `translateX` to the next bucket (false: jump, as on first show). */
  sliding: boolean;
}

export const HIDDEN_CARD: CardState = { visible: false, index: null, sliding: false };

/**
 * The card's next state when the (debounced) hovered bucket changes:
 * - pointer gone (`null`): hide, keep the last bucket for the fade-out;
 * - card out: slide to the new bucket, an empty one too (it then reads "no runs");
 * - card hidden: open on a bucket with data, in place, with no slide;
 *   a first hover on an empty bucket opens nothing.
 */
export function nextCardState(
  prev: CardState,
  shown: number | null,
  isEmpty: (index: number) => boolean,
): CardState {
  if (shown === null) return { ...prev, visible: false, sliding: false };
  if (prev.visible) return { visible: true, index: shown, sliding: true };
  if (isEmpty(shown)) return prev;
  return { visible: true, index: shown, sliding: false };
}

export interface HistogramBar {
  key: string | number;
  ariaLabel: string;
  /** No data in this bucket: a first hover opens no card; an open card reads it in one line. */
  empty: boolean;
  /** The drawn bar, inside a `group/bar` button that fills its slot. */
  bar: ReactNode;
}

export function HistogramBars({
  bars,
  onSelect,
  renderCard,
  className,
}: {
  bars: HistogramBar[];
  onSelect?: (index: number) => void;
  renderCard: (index: number) => ReactNode;
  /** The strip's own classes: height, alignment, gap. */
  className?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const { debouncedValue: shown } = useDebounce(active, HOVER_DEBOUNCE_MS);
  // Derived from the previous render (React's "adjust state while rendering"):
  // the card follows the debounced bucket through `nextCardState`.
  const [card, setCard] = useState<CardState>(HIDDEN_CARD);
  const [prevShown, setPrevShown] = useState<number | null>(null);
  if (shown !== prevShown) {
    setPrevShown(shown);
    setCard(nextCardState(card, shown, (i) => bars[i]?.empty ?? true));
  }
  const cardIndex = card.index;
  const sliding = card.sliding;

  // Widths come from a ResizeObserver, so the clamp follows a resized column.
  const [widths, setWidths] = useState({ strip: 0, card: 0 });
  const stripRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = stripRef.current;
    const card = cardRef.current;
    if (!strip || !card || typeof ResizeObserver === 'undefined') return;
    const measure = () => setWidths({ strip: strip.offsetWidth, card: card.offsetWidth });
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    observer.observe(card);
    return () => observer.disconnect();
  }, []);
  const x =
    cardIndex === null ? 0 : histogramCardOffset(cardIndex, bars.length, widths.strip, widths.card);
  const visible = card.visible;

  return (
    <div className="relative" onPointerLeave={() => setActive(null)}>
      <div ref={stripRef} className={className}>
        {bars.map((b, i) => (
          <button
            key={b.key}
            type="button"
            aria-label={b.ariaLabel}
            onClick={() => onSelect?.(i)}
            onPointerEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onBlur={() => setActive(null)}
            className="group/bar flex h-full min-w-0 flex-1 cursor-pointer items-end outline-none"
          >
            {b.bar}
          </button>
        ))}
      </div>
      <div
        ref={cardRef}
        aria-hidden
        style={{ transform: `translateX(${x}px)` }}
        className={cn(
          'pointer-events-none absolute top-full left-0 z-20 mt-1.5 w-60',
          'bg-popover text-popover-foreground border-border rounded-lg border p-3 shadow-md',
          'ease-default duration-(--duration-normal)',
          sliding ? 'transition-[transform,opacity,translate]' : 'transition-[opacity,translate]',
          'motion-reduce:transition-opacity',
          visible
            ? 'translate-y-0 opacity-100'
            : '-translate-y-1 opacity-0 motion-reduce:translate-y-0',
        )}
      >
        {cardIndex !== null && cardIndex < bars.length ? renderCard(cardIndex) : null}
      </div>
    </div>
  );
}
