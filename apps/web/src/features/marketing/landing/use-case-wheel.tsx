'use client';

import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCases, type ArtifactTone, type UseCase, type UseCaseArtifact } from './content';

const CARDS = useCases.cards;
const COUNT = CARDS.length;

/**
 * Arc geometry.
 *
 * Each card owns a slot on a wheel. `head` is the slot currently at the centre
 * and is driven straight off scroll progress, so scrolling rotates the wheel.
 * A card's signed distance from the centre is `offset = wrap(index - head)`,
 * wrapped into `[-COUNT/2, COUNT/2)` so the deck never runs out of cards on
 * either side — it is a wheel, not a queue.
 *
 * From that offset:
 *   theta = offset * ANGLE_STEP          (rotation, and the angle on the arc)
 *   x     = sin(theta) * RADIUS_X        (fan out sideways)
 *   y     = (1 - cos(theta)) * RADIUS_Y  (drop away from the centre)
 *
 * RADIUS_Y is much smaller than RADIUS_X, so the arc is a wide shallow ellipse
 * that fits inside one viewport instead of a circle that would push the outer
 * cards off the bottom of the screen.
 *
 * Cards are anchored by their own centre (`translate(-50%, -50%)`) on the
 * centre line of the deck box, so the deck is centred by layout rather than by
 * a hand-tuned top offset.
 */
const ANGLE_STEP = 10;
const RADIUS_X = 1500;
const RADIUS_Y = 620;
/**
 * Every card except the head drops below the centre line, so the arc can end up
 * bottom-heavy and sit off-centre in the pinned viewport. `ARC_LIFT` raises the
 * whole wheel to cancel that. It is measured, not guessed: at seven slots and
 * this card height the upright head card is the tallest thing on the arc and
 * already sets both the deck's top and its bottom, so the correction is zero.
 * Re-measure the gap above and below the deck whenever the card height or the
 * card count changes — a shorter card lets the dropped neighbours win the bottom
 * edge and this goes positive.
 */
const ARC_LIFT = 0;
/**
 * Emphasis falloff. The head card is the subject: full size, fully opaque,
 * unblurred, upright. The first neighbour already loses ~28% of its size and
 * more than half its opacity, so the eye has exactly one place to land.
 */
const NEIGHBOUR_SCALE_DROP = 0.32;
const OUTER_SCALE_DROP = 0.1;
const NEIGHBOUR_FADE_DROP = 0.62;
const OUTER_FADE_DROP = 0.14;
/** Blur per slot of distance, capped, so neighbours read as context not copy. */
const BLUR_PER_SLOT = 2.2;
const BLUR_MAX_SLOTS = 2;
/**
 * Cards past `FADE_EDGE` are gone entirely, which hides the wrap-around jump at
 * ±COUNT/2 and lets the deck read as endless. It has to sit inside COUNT/2, or
 * the wrap becomes visible on the far side of the wheel.
 */
const FADE_EDGE = 3;
const FADE_SPAN = 0.9;
/** Total scroll length of the pinned track. Pinned travel is this minus 100vh. */
const TRACK_VH = 380;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/** Signed slot distance, wrapped into [-COUNT/2, COUNT/2). */
function wrapOffset(raw: number): number {
  const half = COUNT / 2;
  return ((((raw + half) % COUNT) + COUNT) % COUNT) - half;
}

/**
 * Ease the fractional part of `head` so the wheel dwells on whole slots and
 * crosses between them quickly. Without this the head card is almost never
 * upright, which is what made no single card read as the subject. The quintic
 * curve holds the head within 0.05 slots of upright for ~63% of the travel, so
 * a reader who stops anywhere is almost always looking at a settled card.
 */
function settle(raw: number): number {
  const base = Math.floor(raw);
  const f = raw - base;
  const eased = f < 0.5 ? 16 * f ** 5 : 1 - (-2 * f + 2) ** 5 / 2;
  return base + eased;
}

/**
 * Semantic colour. This is the only colour in the section, and it is earned:
 * each tone encodes something true about the artifact — a delta's direction, a
 * score band, how late an invoice is. Card frame, borders, type and spacing stay
 * achromatic. Every tone is declared for both themes so neither one washes out.
 */
const TONE_TEXT: Record<ArtifactTone, string> = {
  up: 'text-emerald-600 dark:text-emerald-400',
  down: 'text-rose-600 dark:text-rose-400',
  warn: 'text-amber-600 dark:text-amber-500',
  info: 'text-sky-600 dark:text-sky-400',
};
const TONE_DOT: Record<ArtifactTone, string> = {
  up: 'bg-emerald-500',
  down: 'bg-rose-500',
  warn: 'bg-amber-500',
  info: 'bg-sky-500',
};
const TONE_BAR: Record<ArtifactTone, string> = {
  up: 'bg-emerald-500/80 dark:bg-emerald-400/80',
  down: 'bg-rose-500/80 dark:bg-rose-400/80',
  warn: 'bg-amber-500/80 dark:bg-amber-400/80',
  info: 'bg-sky-500/80 dark:bg-sky-400/80',
};

/** A spreadsheet: shaded header, ruled rows, right-aligned tabular figures. */
function Sheet({ artifact }: { artifact: Extract<UseCaseArtifact, { kind: 'sheet' }> }) {
  const toneColumn = artifact.toneColumn ?? artifact.columns.length - 1;
  return (
    <table className="w-full min-w-0 table-fixed border-collapse font-mono text-[9.5px] sm:text-[11.5px]">
      <thead>
        <tr className="bg-muted/60 border-border/60 border-b">
          {artifact.columns.map((column, i) => (
            <th
              key={column}
              style={{ width: artifact.widths[i] }}
              className={cn(
                'text-muted-foreground/70 truncate px-2.5 py-1.5 text-[8.5px] font-normal tracking-widest uppercase sm:px-3 sm:text-[9px]',
                artifact.aligns[i] === 'right' ? 'text-right' : 'text-left',
              )}
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {artifact.rows.map((row) => (
          <tr
            key={row.cells.join('|')}
            className={cn(
              'border-border/40 border-b last:border-b-0',
              row.total && 'border-border/70 border-t',
            )}
          >
            {row.cells.map((cell, i) => (
              <td
                key={`${i}-${cell}`}
                className={cn(
                  'truncate px-2.5 py-[6px] tabular-nums sm:px-3',
                  artifact.aligns[i] === 'right' ? 'text-right' : 'text-left',
                  row.total && 'text-foreground font-medium',
                  !row.total && (i === 0 ? 'text-foreground' : 'text-foreground/70'),
                  row.tone && i === toneColumn && !row.total && TONE_TEXT[row.tone],
                )}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A unified diff: a real `+` / `-` gutter, one column, added and removed tinted. */
function Diff({ artifact }: { artifact: Extract<UseCaseArtifact, { kind: 'diff' }> }) {
  return (
    <div className="py-1">
      {artifact.lines.map((line) => {
        const sign = line[0] === '+' ? '+' : line[0] === '-' ? '-' : ' ';
        const text = line.slice(1);
        return (
          <div
            key={line}
            className={cn(
              'flex gap-2 px-2.5 py-[3px] font-mono text-[9.5px] leading-relaxed sm:px-3 sm:text-[10.5px]',
              sign === '+' && 'bg-emerald-500/10',
              sign === '-' && 'bg-rose-500/10',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'w-[6px] shrink-0 select-none',
                sign === '+' && 'text-emerald-600 dark:text-emerald-400',
                sign === '-' && 'text-rose-600 dark:text-rose-400',
                sign === ' ' && 'text-muted-foreground/30',
              )}
            >
              {sign}
            </span>
            <span
              className={cn(
                'min-w-0 truncate',
                sign === '+' && 'text-emerald-700 dark:text-emerald-300',
                sign === '-' && 'text-rose-700 dark:text-rose-300',
                sign === ' ' && 'text-foreground/70',
              )}
            >
              {text}
            </span>
          </div>
        );
      })}
      <p className="text-muted-foreground/70 px-2.5 pt-1.5 font-mono text-[9px] tracking-wider sm:px-3">
        {artifact.stat}
      </p>
    </div>
  );
}

/** An outreach draft: real recipient / time / subject structure, then the body. */
function Thread({ artifact }: { artifact: Extract<UseCaseArtifact, { kind: 'thread' }> }) {
  return (
    <div>
      <div className="border-border/50 flex items-baseline justify-between gap-2 border-b px-2.5 py-1.5 sm:px-3">
        <span className="text-foreground/70 min-w-0 truncate font-mono text-[9.5px]">
          {artifact.to}
        </span>
        <span className="text-muted-foreground/60 shrink-0 font-mono text-[9.5px] tabular-nums">
          {artifact.time}
        </span>
      </div>
      <p className="text-foreground truncate px-2.5 pt-2 text-[11.5px] font-medium sm:px-3">
        {artifact.subject}
      </p>
      <div className="px-2.5 pt-1 pb-2 sm:px-3">
        {artifact.lines.map((line) => (
          <p key={line} className="text-muted-foreground truncate text-[11px] leading-relaxed">
            {line}
          </p>
        ))}
      </div>
      <p className="mx-2.5 mb-2 inline-flex rounded-sm bg-amber-500/15 px-2 py-[3px] font-mono text-[9px] tracking-wider text-amber-700 uppercase sm:mx-3 dark:text-amber-400">
        {artifact.status}
      </p>
    </div>
  );
}

/** A status list: a severity dot per row, value right-aligned and tabular. */
function Checks({ artifact }: { artifact: Extract<UseCaseArtifact, { kind: 'checks' }> }) {
  return (
    <div className="py-0.5">
      {artifact.items.map((item) => (
        <div
          key={item.label}
          className="border-border/40 flex items-center gap-2 border-b px-2.5 py-[7px] last:border-b-0 sm:px-3"
        >
          <span aria-hidden className={cn('size-[6px] shrink-0 rounded-full', TONE_DOT[item.tone])} />
          <span className="text-foreground/80 min-w-0 flex-1 truncate text-[11px]">
            {item.label}
          </span>
          <span
            className={cn(
              'shrink-0 font-mono text-[10px] tabular-nums sm:text-[10.5px]',
              TONE_TEXT[item.tone],
            )}
          >
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A chart: one bar per row, length proportional, value on the axis line. */
function Chart({ artifact }: { artifact: Extract<UseCaseArtifact, { kind: 'chart' }> }) {
  return (
    <div className="px-2.5 py-2 sm:px-3">
      <p className="text-muted-foreground/60 pb-1.5 font-mono text-[9px] tracking-widest uppercase sm:pb-2.5">
        {artifact.caption}
      </p>
      {artifact.bars.map((bar) => (
        <div key={bar.label} className="flex items-center gap-2 py-[3px] sm:py-[7px]">
          <span className="text-foreground/70 w-[34px] shrink-0 font-mono text-[9.5px] tabular-nums">
            {bar.label}
          </span>
          <span className="bg-muted/70 h-[9px] min-w-0 flex-1 overflow-hidden rounded-[2px]">
            <span
              className={cn('block h-full rounded-[2px]', TONE_BAR[bar.tone])}
              style={{ width: `${bar.pct}%` }}
            />
          </span>
          <span
            className={cn(
              'w-[38px] shrink-0 text-right font-mono text-[9.5px] tabular-nums',
              TONE_TEXT[bar.tone],
            )}
          >
            {bar.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The artifact — the work product a team receives, and the largest thing on the
 * card. It is markup, never a picture of a screen: the card shows what the agent
 * produced, and must never imply a Kortix UI that does not exist.
 */
function Artifact({ artifact }: { artifact: UseCaseArtifact }) {
  return (
    <div className="border-border bg-background mt-auto w-full min-w-0 overflow-hidden rounded-md border">
      <div className="border-border/70 bg-muted/30 flex items-baseline justify-between gap-2 border-b px-2.5 py-2 sm:px-3">
        <span className="text-foreground min-w-0 truncate font-mono text-[10px] sm:text-[10.5px]">
          {artifact.file}
        </span>
        <span className="text-muted-foreground/50 shrink-0 font-mono text-[9px] tracking-widest uppercase">
          {useCases.artifactLabel}
        </span>
      </div>

      {artifact.kind === 'sheet' ? <Sheet artifact={artifact} /> : null}
      {artifact.kind === 'diff' ? <Diff artifact={artifact} /> : null}
      {artifact.kind === 'thread' ? <Thread artifact={artifact} /> : null}
      {artifact.kind === 'checks' ? <Checks artifact={artifact} /> : null}
      {artifact.kind === 'chart' ? <Chart artifact={artifact} /> : null}

      <div className="border-border/70 text-muted-foreground border-t px-2.5 py-2 text-[10.5px] leading-snug sm:px-3 sm:text-[11px]">
        {artifact.footer}
      </div>
    </div>
  );
}

/**
 * One card. Identical chrome for every department — Kortix is monochrome, so a
 * card is told apart by its mono tag and its artifact, not by a colour.
 */
function UseCaseCard({ card, index, active }: { card: UseCase; index: number; active: boolean }) {
  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <span className="text-foreground/80 font-mono text-[10px] tracking-widest uppercase">
          {card.tag}
        </span>
        <span className="text-muted-foreground/40 font-mono text-[10px] tabular-nums">
          {String(index + 1).padStart(2, '0')}
        </span>
      </div>
      <h3
        className={cn(
          'mt-3 text-[16px] leading-snug font-medium tracking-tight text-balance sm:mt-4 sm:text-[20px]',
          active ? 'text-foreground' : 'text-foreground/85',
        )}
      >
        {card.headline}
      </h3>
      <p className="text-muted-foreground mt-2 text-[12px] leading-relaxed sm:text-[13.5px]">
        {card.body}
      </p>
      <Artifact artifact={card.artifact} />
    </>
  );
}

const CARD_SHELL =
  'border-border bg-card flex flex-col rounded-xl border p-4 sm:p-5 transition-shadow duration-300';

const EDGE_MASK =
  'linear-gradient(to right, transparent 0%, #000 7%, #000 93%, transparent 100%)';

/** Header, shared by the wheel and the reduced-motion grid. */
function SectionHeader({ counter }: { counter?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-7xl px-6">
      <Badge variant="kortix" className="rounded">
        {useCases.eyebrow}
      </Badge>
      <div className="mt-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <h2
          id="use-case-wheel-title"
          className="text-foreground max-w-3xl text-3xl font-medium tracking-tight text-balance sm:text-4xl"
        >
          {useCases.title}
        </h2>
        {counter}
      </div>
      <p className="text-muted-foreground mt-4 max-w-2xl text-base leading-relaxed">
        {useCases.sub}
      </p>
    </div>
  );
}

/** `prefers-reduced-motion` fallback: the same seven cards, no transforms. */
function UseCaseGrid() {
  return (
    <section
      id="use-cases"
      aria-labelledby="use-case-wheel-title"
      className="py-16 sm:py-24"
    >
      <SectionHeader />
      <div className="mx-auto mt-12 grid w-full max-w-7xl grid-cols-1 gap-4 px-6 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((card, index) => (
          <article key={card.id} className={CARD_SHELL}>
            <UseCaseCard card={card} index={index} active={false} />
          </article>
        ))}
      </div>
    </section>
  );
}

export function UseCaseWheel(): ReactNode {
  const trackRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Array<HTMLElement | null>>([]);
  const activeRef = useRef(0);
  const [activeIndex, setActiveIndex] = useState(0);

  const prefersReduced = useReducedMotion();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Server and first client render always take the wheel branch, so the tree
  // cannot mismatch during hydration; the grid swaps in after mount.
  const reduce = mounted && (prefersReduced ?? false);

  useEffect(() => {
    if (reduce) return;

    let frame = 0;

    const paint = () => {
      frame = 0;
      const track = trackRef.current;
      if (!track) return;

      const span = track.offsetHeight - window.innerHeight;
      const progress = span <= 0 ? 0 : clamp01(-track.getBoundingClientRect().top / span);
      const head = settle(progress * (COUNT - 1));

      // Narrow screens get a tighter fan so the outer cards stay on screen.
      const spread = Math.min(1, window.innerWidth / 1280);

      let nearest = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;

      for (let i = 0; i < COUNT; i += 1) {
        const offset = wrapOffset(i - head);
        const distance = Math.abs(offset);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = i;
        }

        const el = cardRefs.current[i];
        if (!el) continue;

        const theta = offset * ANGLE_STEP;
        const rad = (theta * Math.PI) / 180;
        const x = Math.sin(rad) * RADIUS_X * spread;
        const y = (1 - Math.cos(rad)) * RADIUS_Y - ARC_LIFT;

        // Two-piece falloff: a hard step out to the first neighbour, then a
        // gentle taper. The step is what makes the head card the subject.
        const near = Math.min(distance, 1);
        const far = Math.max(0, Math.min(distance, FADE_EDGE) - 1);
        const scale = 1 - near * NEIGHBOUR_SCALE_DROP - far * OUTER_SCALE_DROP;
        const dim = 1 - near * NEIGHBOUR_FADE_DROP - far * OUTER_FADE_DROP;
        const fade = Math.min(clamp01(dim), clamp01((FADE_EDGE - distance) / FADE_SPAN));
        const blur = Math.min(distance, BLUR_MAX_SLOTS) * BLUR_PER_SLOT;

        el.style.transform = `translate(-50%, -50%) translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${theta.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
        el.style.opacity = fade.toFixed(3);
        el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : 'none';
        el.style.zIndex = String(50 - Math.round(distance * 8));
        el.style.visibility = fade > 0 ? 'visible' : 'hidden';
      }

      if (activeRef.current !== nearest) {
        activeRef.current = nearest;
        setActiveIndex(nearest);
      }
    };

    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(paint);
    };

    paint();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [reduce]);

  if (reduce) return <UseCaseGrid />;

  return (
    <section id="use-cases" aria-labelledby="use-case-wheel-title">
      <div ref={trackRef} className="relative" style={{ height: `${TRACK_VH}vh` }}>
        {/* Pinned viewport: header on top, wheel below. `overflow-hidden` sits on
            the sticky element itself so the fanned cards can never widen the
            document and produce a horizontal scrollbar. */}
        <div className="sticky top-0 flex h-screen flex-col overflow-hidden pt-20">
          <SectionHeader
            counter={
              <div className="flex shrink-0 items-center gap-3">
                <div aria-hidden className="flex items-end gap-[3px]">
                  {CARDS.map((card, index) => (
                    <span
                      key={card.id}
                      className={cn(
                        'w-[3px] rounded-full transition-all duration-300',
                        index === activeIndex ? 'bg-foreground h-4' : 'bg-foreground/20 h-2',
                      )}
                    />
                  ))}
                </div>
                <span className="text-muted-foreground/60 font-mono text-[11px] tabular-nums">
                  {String(activeIndex + 1).padStart(2, '0')} / {String(COUNT).padStart(2, '0')}
                </span>
              </div>
            }
          />

          {/* `flex-1` claims every pixel under the header; the cards hang off the
              vertical midpoint of this box, so the deck is centred by layout. */}
          <div
            className="relative mx-auto w-full flex-1"
            data-active-index={activeIndex}
            // Softens the point where the deck runs off the left and right edges,
            // so the wheel reads as endless instead of clipped.
            style={{
              maskImage: EDGE_MASK,
              WebkitMaskImage: EDGE_MASK,
            }}
          >
            {CARDS.map((card, index) => (
              <article
                key={card.id}
                ref={(node) => {
                  cardRefs.current[index] = node;
                }}
                data-use-case={card.id}
                data-active={index === activeIndex ? 'true' : 'false'}
                className={cn(
                  CARD_SHELL,
                  'relative',
                  'absolute top-1/2 left-1/2 h-[368px] w-[292px] will-change-transform sm:h-[404px] sm:w-[468px]',
                  'shadow-none data-[active=true]:shadow-2xl data-[active=true]:border-foreground/20',
                )}
                style={{ transform: 'translate(-50%, -50%)' }}
              >
                <UseCaseCard card={card} index={index} active={index === activeIndex} />
                {card.href && index === activeIndex ? (
                  // The whole card is the target. An overlay keeps it a card
                  // that happens to navigate, with no extra row of chrome, and
                  // only the head card is reachable — the rest are blurred.
                  <Link
                    href={card.href}
                    aria-label={`${card.role} — ${card.headline}`}
                    className="focus-visible:ring-ring absolute inset-0 rounded-xl focus-visible:ring-2 focus-visible:outline-none"
                  />
                ) : null}
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
