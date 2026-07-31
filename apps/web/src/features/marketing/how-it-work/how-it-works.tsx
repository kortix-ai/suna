'use client';

import { Badge } from '@/components/ui/badge';
import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { useMediaQuery } from '@/hooks/utils/use-media-query';
import { cn } from '@/lib/utils';
import {
  cubicBezier,
  motion,
  useMotionTemplate,
  useReducedMotion,
  useScroll,
  useTransform,
  type MotionValue,
} from 'motion/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LAYERS, SECTION, type Layer } from './how-it-works-content';
import { StepComputer } from './step/step-computer';
import { StepConnectors } from './step/step-connectors';
import { StepControlPlane } from './step/step-control-plane';
import { StepHarness } from './step/step-harness';
import { StepModels } from './step/step-models';
import { StepSourceOfTruth } from './step/step-source-of-truth';

/**
 * How long the section holds the viewport: 260vh total, so 160vh of pinned
 * scroll across seven cards — about 27vh each. The number is a budget, not a
 * preference: an earlier version of this section pinned for 366vh and was
 * rejected as too much scroll.
 */
const SECTION_HEIGHT = 'lg:h-[260vh]';

const LAST = LAYERS.length - 1;

/** Cards decelerate into place rather than tracking the scroll on a hard ramp. */
const TRAVEL_EASE = cubicBezier(0.33, 0, 0.15, 1);

/**
 * The height of one collapsed title bar, in px.
 *
 * `LAST` of these are always reserved — `i` above the active card and
 * `LAST - i` below it — so every 4px here costs the active card's panel 24px.
 * It is kept as small as a 15px title can legibly sit in.
 */
function stripHeight(viewportHeight: number): number {
  return Math.round(Math.min(34, Math.max(28, viewportHeight * 0.034)));
}

function LayerShowcase({ layer }: { layer: Layer }): ReactNode {
  switch (layer.id) {
    case 'source':
      return <StepSourceOfTruth />;
    case 'context':
      return <StepConnectors />;
    case 'models':
      return <StepModels />;
    case 'harness':
      return <StepHarness />;
    case 'computer':
      return <StepComputer />;
    case 'control-plane':
      return <StepControlPlane />;
    // The closing card draws its own body — a mark and a line, no panel.
    case 'kortix':
      return null;
  }
}

/**
 * One card.
 *
 * The geometry is exact, and it is what lets all seven cards share one screen.
 * At any moment `i` cards are parked above as title bars and `LAST - i` are
 * docked below as title bars — that is always `LAST` bars — so every card can
 * be the same height, `frame - LAST × strip`, and the seven of them tile the
 * frame with no gap and no overlap.
 *
 * Blur and dim sit on the card BODY, never on its title bar: a parked card is
 * only worth keeping if you can still read which layer it is.
 */
function LayerCard({
  layer,
  index,
  pinned,
  frame,
  strip,
  progress,
  onSeek,
}: {
  layer: Layer;
  index: number;
  pinned: boolean;
  frame: number;
  strip: number;
  progress: MotionValue<number>;
  onSeek: (index: number) => void;
}): ReactNode {
  const restTop = index * strip;
  // Where the card waits its turn: docked at the bottom of the frame, in order,
  // showing exactly its own title bar.
  const dockTop = frame - (LAST - index + 1) * strip;

  // It travels over the one step of scroll before it comes to rest, and recedes
  // over the three steps after. Three is where the taper stops reading, and
  // capping it keeps a sixth blurred layer off the compositor.
  const arriveFrom = (index - 1) / LAST;
  const arriveTo = index / LAST;
  const recedeTo = Math.min(index + 3, LAST) / LAST;

  const y = useTransform(progress, [arriveFrom, arriveTo], [dockTop - restTop, 0], {
    clamp: true,
    // Eased, not linear: the card decelerates into place instead of arriving on
    // a hard scroll-linked ramp.
    ease: TRAVEL_EASE,
  });
  const depth = useTransform(progress, [arriveTo, recedeTo], [0, 1], { clamp: true });
  const blurPx = useTransform(depth, [0, 1], [0, 6]);
  const bodyOpacity = useTransform(depth, [0, 1], [1, 0.4]);
  const filter = useMotionTemplate`blur(${blurPx}px)`;

  const isLast = index === LAST;
  const isClosing = layer.id === 'kortix';
  const live = pinned && frame > 0;

  return (
    <motion.article
      data-stack-layer={layer.id}
      data-pinned={live ? 'true' : 'false'}
      style={
        live
          ? {
              top: restTop,
              height: frame - LAST * strip,
              zIndex: index,
              y,
              willChange: 'transform',
            }
          : undefined
      }
      className={cn(
        'border-border bg-popover flex flex-col overflow-hidden rounded-xl border',
        live ? 'absolute inset-x-0' : 'relative',
      )}
    >
      <button
        type="button"
        onClick={() => onSeek(index)}
        data-card-head
        style={live ? { height: strip } : undefined}
        className="hover:bg-muted/50 flex w-full shrink-0 cursor-pointer items-center gap-3 px-4 py-1 text-left transition-colors sm:px-6"
      >
        <span className="text-muted-foreground/60 font-mono text-[11px] tracking-widest tabular-nums">
          {layer.ordinal}
        </span>
        <h3 className="text-foreground truncate text-[15px] font-medium tracking-tight sm:text-base">
          {layer.title}
        </h3>
      </button>

      <motion.div
        data-card-body
        style={live && !isLast ? { filter, opacity: bodyOpacity, willChange: 'filter' } : undefined}
        className={cn(
          'border-border bg-muted/40 dark:bg-muted/15 min-h-0 flex-1 border-t p-2',
          isClosing
            ? 'flex items-center justify-center'
            : 'grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-4',
        )}
      >
        {isClosing ? (
          <div
            className={cn(
              'flex flex-col items-center justify-center gap-5 text-center',
              live ? 'h-full' : 'py-16',
            )}
          >
            <KortixLogo size={64} variant="icon" className="text-foreground" />
            <p className="text-foreground max-w-md text-balance">{layer.description}</p>
            <p className="text-muted-foreground/60 font-mono text-[10px] tracking-widest tabular-nums">
              {LAYERS.slice(0, LAST)
                .map((l) => l.ordinal)
                .join(' · ')}
            </p>
          </div>
        ) : (
          <>
            <div className="flex min-w-0 flex-col gap-2.5 lg:pl-1">
              <p className="text-muted-foreground text-[13px] leading-relaxed">
                {layer.description}
              </p>
              <ul className="text-muted-foreground space-y-1.5 text-[12.5px] leading-relaxed">
                {layer.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-2">
                    <KortixAsterisk index={index} parentClass="mt-0 size-4" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Unpinned the panel needs a height of its own; pinned it takes
                whatever the frame has left under the title bars. */}
            <div className={cn('min-h-0 w-full', live ? 'h-full' : 'h-[16rem] sm:h-[19rem]')}>
              <LayerShowcase layer={layer} />
            </div>
          </>
        )}
      </motion.div>
    </motion.article>
  );
}

/**
 * The platform stack.
 *
 * The section locks to the viewport when you reach it: the heading stays put,
 * and the layers build inside it. Cards you have passed stay above as title
 * bars, cards you have not reached wait below as title bars, so the frame
 * always holds the heading, all seven titles, and the active layer's real
 * product panel. Every title bar is a control that seeks to its card. The
 * seventh card is the full stop — without it the sixth layer sat open at the
 * bottom of the section forever and the stack never resolved.
 *
 * Below `lg`, and under `prefers-reduced-motion`, none of that applies: it is a
 * plain vertical list of the same seven cards.
 */
export function HowItWorks(): ReactNode {
  const reduced = useReducedMotion();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const pinned = isDesktop && !reduced;

  const sectionRef = useRef<HTMLElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState(0);
  const [strip, setStrip] = useState(() => stripHeight(900));

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ['start start', 'end end'],
  });

  // The card geometry is in pixels, so it has to be measured rather than
  // guessed: the frame is whatever the heading leaves behind.
  useEffect(() => {
    const el = stackRef.current;
    if (!el || !pinned) {
      setFrame(0);
      return;
    }
    const sync = () => {
      setFrame(el.getBoundingClientRect().height);
      setStrip(stripHeight(window.innerHeight));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener('resize', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [pinned]);

  const seek = useCallback(
    (index: number) => {
      const el = sectionRef.current;
      if (!el || !pinned) return;
      const { top, height } = el.getBoundingClientRect();
      const pinDistance = height - window.innerHeight;
      window.scrollTo({
        top: top + window.scrollY + (pinDistance * index) / LAST,
        behavior: 'smooth',
      });
    },
    [pinned],
  );

  return (
    <section
      id="platform-stack"
      ref={sectionRef}
      className={cn('relative', pinned && SECTION_HEIGHT)}
    >
      <div className={cn(pinned && 'sticky top-0 flex h-[100svh] flex-col overflow-hidden')}>
        {/* One measure for the whole section: `mx-auto max-w-7xl px-6`, the same
            shell every other marketing section uses. The cards live inside a
            padding-free child of the same box, because an absolutely positioned
            card resolves `inset-x-0` against the padding box and would sit 24px
            wider than the heading it belongs to. */}
        <div className="mx-auto w-full max-w-7xl shrink-0 px-6 pt-[4.75rem] [@media(max-height:860px)]:pt-[4.5rem]">
          <Badge
            variant="kortix"
            className="rounded font-mono text-[10px] tracking-widest uppercase"
          >
            {SECTION.eyebrow}
          </Badge>
          <h2 className="text-foreground mt-3 max-w-3xl text-2xl font-medium tracking-tight text-balance sm:text-3xl [@media(max-height:860px)]:mt-2 [@media(max-height:860px)]:sm:text-2xl">
            {SECTION.title}
          </h2>
          {/* On a short laptop screen this line is the first thing to go: it is
              the only element in the frame whose job the six card titles
              already do, and every 20px it takes comes straight out of the
              active layer's panel. */}
          <p className="text-muted-foreground mt-2 max-w-2xl text-sm leading-relaxed [@media(max-height:860px)]:hidden">
            {SECTION.description}
          </p>
        </div>

        <div
          className={cn(
            'mx-auto w-full max-w-7xl px-6',
            pinned ? 'mt-3 min-h-0 flex-1 pb-4' : 'mt-8 pb-16 sm:mt-10',
          )}
        >
          {/* `overflow-hidden` on the stack itself, not just the pinned shell:
              a card waiting its turn is taller than the strip it shows, and
              without this its body leaks into the gap under the frame. */}
          <div
            ref={stackRef}
            className={cn(pinned ? 'relative h-full overflow-hidden' : 'flex flex-col gap-5')}
          >
            {LAYERS.map((layer, index) => (
              <LayerCard
                key={layer.id}
                layer={layer}
                index={index}
                pinned={pinned}
                frame={frame}
                strip={strip}
                progress={scrollYProgress}
                onSeek={seek}
              />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
