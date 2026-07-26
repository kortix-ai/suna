'use client';

import { heroSteps } from '@/features/landing/content';
import { CliBlock, stepUiPanels } from '@/features/landing/step-visuals';
import { HeroSurfaces } from '@/features/marketing/hero-surfaces';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The hero product stage — the whole Kortix flow, driven by scroll.
 *
 * The section pins while you scroll through the steps, so you can't skim past
 * the story. This uses a tall spacer + `position: sticky` and derives the
 * active step from scroll progress, rather than capturing wheel events and
 * calling preventDefault. That distinction matters: native scroll keeps
 * trackpad momentum, keyboard paging, find-in-page, and mobile fling all
 * working, and the section can never trap someone.
 *
 * Below `lg` (and under prefers-reduced-motion) the pin is dropped entirely and
 * the stepper becomes a plain tab strip — scroll-linked storytelling on a phone
 * is mostly a way to make a page feel broken.
 *
 * Every step can be viewed two ways: the interface a non-technical person sees,
 * and the developer equivalent (a kortix.yaml block, a SKILL.md, a CLI run).
 */

/** Viewport heights of scroll per step while pinned. */
const SCROLL_PER_STEP = 0.85;
/** Dwell per step when the carousel is auto-advancing instead of pinned. */
const STEP_MS = 8000;

type ViewMode = 'ui' | 'dev';

export function HeroStage({ className }: { className?: string }) {
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<ViewMode>('ui');
  const [pinned, setPinned] = useState(false);
  const [cycle, setCycle] = useState(0);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const step = heroSteps[index];

  const select = useCallback((i: number) => {
    setIndex(i);
    setCycle((c) => c + 1);
  }, []);

  // Only pin on wide viewports with a fine pointer — see the note above.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px) and (pointer: fine)');
    const sync = () => setPinned(mq.matches && !reduceMotion);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [reduceMotion]);

  // Pinned: the step is a pure function of how far through the spacer we are.
  useEffect(() => {
    if (!pinned) return;
    const el = scrollerRef.current;
    if (!el) return;

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const rect = el.getBoundingClientRect();
        const total = rect.height - window.innerHeight;
        if (total <= 0) return;
        const progress = Math.min(Math.max(-rect.top / total, 0), 0.9999);
        setIndex(Math.floor(progress * heroSteps.length));
      });
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [pinned]);

  // Not pinned: fall back to a timed carousel. A click restarts the dwell
  // rather than freezing it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: index/cycle re-arm the timer
  useEffect(() => {
    if (pinned || reduceMotion) return;
    timer.current = setTimeout(() => {
      setIndex((i) => (i + 1) % heroSteps.length);
    }, STEP_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [index, cycle, pinned, reduceMotion]);

  const stage = (
    <>
      <div className="bg-foreground relative overflow-hidden rounded-lg border">
        <div className="flex min-h-[26rem] items-center gap-8 px-6 py-10 sm:min-h-[32rem] sm:px-10 sm:py-12">
          <div className="relative z-20 w-full shrink-0 sm:w-[21rem]">
            <AnimatePresence mode="wait">
              <motion.div
                key={step.id}
                initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -12 }}
                transition={{ type: 'spring', duration: 0.4, bounce: 0 }}
              >
                <p className="text-background/50 font-mono text-xs tracking-wider uppercase">
                  Step {index + 1} / {heroSteps.length}
                </p>
                <h3 className="text-background mt-4 text-2xl leading-tight font-medium tracking-tight sm:text-3xl">
                  {step.title}
                </h3>
                <p className="text-background/70 mt-4 text-sm leading-relaxed">{step.body}</p>
              </motion.div>
            </AnimatePresence>

            <ViewToggle mode={mode} onChange={setMode} />
          </div>

          <div className="relative hidden min-w-0 flex-1 sm:block">
            <AnimatePresence mode="wait">
              <motion.div
                key={`${step.id}-${mode}`}
                initial={reduceMotion ? false : { opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, x: -12 }}
                transition={{ type: 'spring', duration: 0.45, bounce: 0 }}
                className="h-[23rem]"
              >
                <StepVisual step={step} mode={mode} />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>

      <Stepper
        index={index}
        cycle={cycle}
        pinned={pinned}
        reduceMotion={Boolean(reduceMotion)}
        onSelect={select}
        scrollerRef={scrollerRef}
      />
    </>
  );

  if (!pinned) {
    return (
      <div className={className} id="flow" style={{ scrollMarginTop: '5rem' }}>
        {stage}
      </div>
    );
  }

  // Spacer is as tall as the whole story; the stage sticks inside it.
  //
  // The sticky child is exactly one viewport tall (`h-screen`) so that when it
  // releases at the bottom of the spacer there is no leftover gap — a shorter
  // sticky child leaves dead whitespace between here and the next section.
  return (
    <div
      ref={scrollerRef}
      className={className}
      id="flow"
      // One viewport for the pinned stage itself, plus a slice of scroll per
      // *transition* (steps - 1). Budgeting a slice for the last step too would
      // leave a viewport of dead space after it.
      style={{ height: `${(heroSteps.length - 1) * SCROLL_PER_STEP * 100 + 100}vh` }}
    >
      <div className="sticky top-0 flex h-screen flex-col justify-center pt-16">{stage}</div>
    </div>
  );
}

function Stepper({
  index,
  cycle,
  pinned,
  reduceMotion,
  onSelect,
  scrollerRef,
}: {
  index: number;
  cycle: number;
  pinned: boolean;
  reduceMotion: boolean;
  onSelect: (i: number) => void;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}) {
  // While pinned, clicking a label scrolls to that step's slice of the spacer
  // so the pointer and the scrollbar never disagree about where we are.
  const handle = (i: number) => {
    if (!pinned) {
      onSelect(i);
      return;
    }
    const el = scrollerRef.current;
    if (!el) return;
    const total = el.offsetHeight - window.innerHeight;
    const top = el.offsetTop + (total * (i + 0.5)) / heroSteps.length;
    window.scrollTo({ top, behavior: 'smooth' });
  };

  return (
    <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 lg:grid-cols-8 lg:gap-x-2">
      {heroSteps.map((s, i) => {
        const active = i === index;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => handle(i)}
            aria-current={active ? 'step' : undefined}
            className="group cursor-pointer text-left"
          >
            <span className="bg-border relative block h-0.5 w-full overflow-hidden rounded-full">
              {active && !pinned ? (
                <motion.span
                  key={`${s.id}-${cycle}`}
                  className="bg-foreground absolute inset-y-0 left-0 block"
                  initial={{ width: reduceMotion ? '100%' : '0%' }}
                  animate={{ width: '100%' }}
                  transition={
                    reduceMotion ? { duration: 0 } : { duration: STEP_MS / 1000, ease: 'linear' }
                  }
                />
              ) : (
                <span
                  className={cn(
                    'absolute inset-y-0 left-0 block w-0 transition-all duration-300',
                    (active || i < index) && 'bg-foreground w-full',
                    i < index && 'bg-foreground/30',
                  )}
                />
              )}
            </span>
            <span
              className={cn(
                'mt-2.5 block text-xs font-medium transition-colors lg:text-[13px]',
                active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
              )}
            >
              {s.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Interface ↔ Developer switch. Sits under the step copy, on the dark canvas. */
function ViewToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <fieldset className="border-background/15 mt-8 inline-flex rounded-full border p-0.5">
      <legend className="sr-only">Choose how to view this step</legend>
      {(['ui', 'dev'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          aria-pressed={mode === m}
          className={cn(
            'cursor-pointer rounded-full px-3.5 py-1 text-xs font-medium transition-colors',
            mode === m
              ? 'bg-background text-foreground'
              : 'text-background/60 hover:text-background',
          )}
        >
          {m === 'ui' ? 'Interface' : 'Developer'}
        </button>
      ))}
    </fieldset>
  );
}

function StepVisual({ step, mode }: { step: (typeof heroSteps)[number]; mode: ViewMode }) {
  if (mode === 'dev') {
    return <CliBlock file={step.cli.file} lines={step.cli.lines} />;
  }
  const { ui } = step;
  if (ui.kind === 'surfaces') {
    return (
      <div className="bg-card h-full overflow-hidden rounded-xl border p-4 shadow-2xl">
        <HeroSurfaces />
      </div>
    );
  }
  const Panel = stepUiPanels[ui.panel];
  return <Panel />;
}
