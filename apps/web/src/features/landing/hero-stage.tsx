'use client';

import { heroSteps } from '@/features/landing/content';
import { CliBlock, stepUiPanels } from '@/features/landing/step-visuals';
import { HeroSurfaces } from '@/features/marketing/hero-surfaces';
import { cn } from '@/lib/utils';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The hero product stage — the Kortix flow as a seven-step carousel, with the
 * stepper underneath the canvas.
 *
 * Every step can be viewed two ways: the UI a non-technical person sees, and
 * the developer equivalent for the same action (a kortix.yaml block, a SKILL.md,
 * a CLI run). The toggle is sticky across steps, so a developer flips to Dev
 * once and stays there for the whole story.
 *
 * Clicking a step restarts the dwell timer from that step rather than stopping
 * the carousel — an earlier version froze on first interaction, which read as
 * broken.
 */

const STEP_MS = 8000;

type ViewMode = 'ui' | 'dev';

export function HeroStage({ className }: { className?: string }) {
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<ViewMode>('ui');
  // Bumped on every manual step change so the effect below re-arms the timer
  // and the progress bar restarts from zero.
  const [cycle, setCycle] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const step = heroSteps[index];

  const select = useCallback((i: number) => {
    setIndex(i);
    setCycle((c) => c + 1);
  }, []);

  // `index` and `cycle` both re-arm the advance timer — that is the mechanism,
  // not a missing dependency.
  // biome-ignore lint/correctness/useExhaustiveDependencies: index/cycle re-arm the timer
  useEffect(() => {
    if (reduceMotion) return;
    timer.current = setTimeout(() => {
      setIndex((i) => (i + 1) % heroSteps.length);
    }, STEP_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [index, cycle, reduceMotion]);

  return (
    <div className={className} id="flow" style={{ scrollMarginTop: '5rem' }}>
      <div className="bg-foreground relative overflow-hidden rounded-lg border">
        <div className="flex min-h-[26rem] items-center gap-8 px-6 py-10 sm:min-h-[34rem] sm:px-10 sm:py-14">
          <div className="relative z-20 w-full shrink-0 sm:w-[21rem]">
            <AnimatePresence mode="wait">
              <motion.div
                key={step.id}
                initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, y: -12 }}
                transition={{ type: 'spring', duration: 0.45, bounce: 0 }}
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
                transition={{ type: 'spring', duration: 0.5, bounce: 0 }}
                className="h-[24rem]"
              >
                <StepVisual step={step} mode={mode} />
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Stepper — underneath the canvas. */}
      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4 lg:grid-cols-7 lg:gap-x-3">
        {heroSteps.map((s, i) => {
          const active = i === index;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => select(i)}
              aria-current={active ? 'step' : undefined}
              className="group cursor-pointer text-left"
            >
              <span className="bg-border relative block h-0.5 w-full overflow-hidden rounded-full">
                {active ? (
                  <motion.span
                    // Keyed on cycle so a manual jump restarts the fill.
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
                      'absolute inset-y-0 left-0 block w-0',
                      i < index && 'bg-foreground/30 w-full',
                    )}
                  />
                )}
              </span>
              <span
                className={cn(
                  'mt-2.5 block text-sm font-medium transition-colors',
                  active ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground',
                )}
              >
                {s.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** UI ↔ Dev switch. Sits under the step copy, on the dark canvas. */
function ViewToggle({
  mode,
  onChange,
}: {
  mode: ViewMode;
  onChange: (m: ViewMode) => void;
}) {
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
