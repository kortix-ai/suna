'use client';

import { KortixAsterisk } from '@/components/ui/kortix-asterisk';
import { KortixLogo } from '@/components/ui/kortix-logo';
import { useMediaQuery } from '@/hooks/utils/use-media-query';
import { cn } from '@/lib/utils';
import { m, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LAYERS, SECTION, type Layer } from './how-it-works-content';
import { StepComputer } from './step/step-computer';
import { StepConnectors } from './step/step-connectors';
import { StepControlPlane } from './step/step-control-plane';
import { StepHarness } from './step/step-harness';
import { StepModels } from './step/step-models';
import { StepSourceOfTruth } from './step/step-source-of-truth';

const LAST = LAYERS.length - 1;

/** The rail indicator slides between items on a snappy UI spring — no bounce. */
const RAIL_SPRING = { type: 'spring', stiffness: 400, damping: 34 } as const;

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
    // The closing step draws its own body — a mark and a line, no panel.
    case 'kortix':
      return null;
  }
}

/** The closing step: the six layers add up to one thing. No product panel. */
function ClosingPane({ layer, className }: { layer: Layer; className?: string }): ReactNode {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-5 text-center', className)}>
      <KortixLogo size={64} variant="icon" className="text-foreground" />
      <p className="text-foreground max-w-md text-balance">{layer.description}</p>
      <p className="text-muted-foreground/60 font-mono text-[10px] tracking-widest tabular-nums">
        {LAYERS.slice(0, LAST)
          .map((l) => l.ordinal)
          .join(' · ')}
      </p>
    </div>
  );
}

/**
 * One desktop layer. The lead is two-tone on purpose: the claim (`title`) in
 * foreground, the explanation (`description`) running on in muted. The bullets
 * sit in a row under it; the product panel has a fixed height so stacked
 * layers don't collapse when they are no longer filling a pinned viewport.
 */
function StepPane({ layer, index }: { layer: Layer; index: number }): ReactNode {
  if (layer.id === 'kortix') {
    return <ClosingPane layer={layer} className="py-24" />;
  }

  return (
    <div className="flex min-h-0 flex-col space-y-10">
      <p className="max-w-2xl text-lg leading-snug tracking-tight text-pretty sm:text-xl">
        <span className="text-foreground font-medium">{layer.title}</span>{' '}
        <span className="text-muted-foreground">{layer.description}</span>
      </p>

      {/* <ul className="text-muted-foreground grid shrink-0 grid-cols-3 gap-5 text-[12.5px] leading-relaxed">
        {layer.bullets.map((bullet) => (
          <li key={bullet} className="flex gap-2">
            <KortixAsterisk index={index} parentClass="mt-0 size-4" />
            <span>{bullet}</span>
          </li>
        ))}
      </ul> */}

      <div
        className={cn(
          layer.id === 'computer'
            ? 'flex h-88 min-h-0 flex-col overflow-hidden sm:h-112 xl:h-128'
            : 'border-border bg-muted/40 dark:bg-muted/15 flex h-88 min-h-0 flex-col overflow-hidden rounded-xl border sm:h-112 xl:h-128',
        )}
      >
        <LayerShowcase layer={layer} />
      </div>
    </div>
  );
}

/**
 * One card of the plain vertical list — everything below `lg`, and every
 * viewport under `prefers-reduced-motion`. Same copy, same panels, no pin.
 */
function MobileCard({ layer, index }: { layer: Layer; index: number }): ReactNode {
  const isClosing = layer.id === 'kortix';

  return (
    <article
      data-stack-layer={layer.id}
      className="border-border bg-popover flex flex-col overflow-hidden rounded-xl border"
    >
      <div className="flex w-full items-center gap-3 px-4 py-2 sm:px-6">
        <span className="text-muted-foreground/60 font-mono text-[11px] tracking-widest tabular-nums">
          {layer.ordinal}
        </span>
        <h3 className="text-foreground truncate text-[15px] font-medium tracking-tight sm:text-base">
          {layer.title}
        </h3>
      </div>

      <div
        className={cn(
          'border-border bg-muted/40 dark:bg-muted/15 border-t p-2',
          !isClosing && 'flex flex-col gap-3',
        )}
      >
        {isClosing ? (
          <ClosingPane layer={layer} className="py-16" />
        ) : (
          <>
            <div className="flex min-w-0 flex-col gap-2.5 px-2 pt-2">
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

            <div className="flex h-[16rem] min-h-0 w-full flex-col sm:h-[19rem]">
              <LayerShowcase layer={layer} />
            </div>
          </>
        )}
      </div>
    </article>
  );
}

/**
 * The platform stack.
 *
 * Desktop: the seven layers sit in a column. The left rail is the only sticky
 * element (`self-start` so the grid does not stretch it to the content height,
 * which would cancel sticky). Scroll-spy lights the rail; a click seeks the
 * matching pane. The seventh entry is the full stop.
 *
 * Below `lg`, and under `prefers-reduced-motion`, it is a plain vertical list
 * of the same seven cards.
 */
export function HowItWorks(): ReactNode {
  const reduced = useReducedMotion();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const pinned = isDesktop && !reduced;

  const sectionRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!pinned) return;
    const root = sectionRef.current;
    if (!root) return;

    const panes = [...root.querySelectorAll<HTMLElement>('[data-stack-pane]')];
    const obs = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!hit) return;
        const id = hit.target.getAttribute('data-stack-pane');
        const next = LAYERS.findIndex((layer) => layer.id === id);
        if (next >= 0) setActive(next);
      },
      { rootMargin: '-20% 0px -55% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    panes.forEach((pane) => obs.observe(pane));
    return () => obs.disconnect();
  }, [pinned]);

  const seek = useCallback((index: number) => {
    const id = LAYERS[index]?.id;
    if (!id) return;
    document.getElementById(`stack-pane-${id}`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
    });
  }, []);

  return (
    <section id="platform-stack" ref={sectionRef} className="relative space-y-24 md:space-y-30">
      <div className="mx-auto w-full max-w-7xl px-6 pt-[4.75rem] [@media(max-height:860px)]:pt-[4.5rem]">
        <div className="flex flex-col gap-4 select-none">
          <span
            className="text-muted-foreground font-mono text-[0.75rem] leading-none font-normal uppercase select-none"
            data-text="true"
          >
            {SECTION.eyebrow}
          </span>
          <h2
            data-heading="true"
            className="text-foreground max-w-2xl font-sans text-2xl font-medium text-balance sm:text-3xl"
          >
            {SECTION.title}
          </h2>
        </div>

        <p className="text-muted-foreground mt-4 max-w-2xl text-base leading-relaxed">
          {SECTION.description}
        </p>
      </div>

      <div className="mx-auto mt-8 w-full max-w-7xl px-6 pb-16">
        {pinned ? (
          <div className="grid grid-cols-[14rem_minmax(0,1fr)] items-start gap-10 xl:grid-cols-[16rem_minmax(0,1fr)]">
            <nav aria-label={SECTION.eyebrow} className="sticky top-30 flex flex-col gap-1 pt-1">
              {LAYERS.map((layer, index) => {
                const isActive = index === active;
                return (
                  <button
                    key={layer.id}
                    type="button"
                    data-stack-layer={layer.id}
                    data-active={isActive ? 'true' : 'false'}
                    onClick={() => seek(index)}
                    className="group relative flex cursor-pointer items-baseline gap-3 py-2 pl-4 text-left"
                  >
                    {isActive && (
                      <m.span
                        layoutId="stack-rail-indicator"
                        transition={RAIL_SPRING}
                        className="bg-foreground absolute top-1/2 left-0 -mt-2.5 h-5 w-0.5 rounded-full"
                      />
                    )}
                    <span
                      className={cn(
                        'text-base font-medium tracking-tight transition-colors duration-200',
                        isActive
                          ? 'text-foreground'
                          : 'text-muted-foreground/40 group-hover:text-muted-foreground',
                      )}
                    >
                      {layer.label}
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="flex min-w-0 flex-col gap-24 xl:gap-30">
              {LAYERS.map((layer, index) => (
                <div
                  key={layer.id}
                  id={`stack-pane-${layer.id}`}
                  data-stack-pane={layer.id}
                  className="scroll-mt-30"
                >
                  <StepPane layer={layer} index={index} />
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {LAYERS.map((layer, index) => (
              <MobileCard key={layer.id} layer={layer} index={index} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
