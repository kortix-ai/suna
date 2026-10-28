'use client';

import { MANIFEST } from '@/features/marketing/framework/content';
import { cn } from '@kortix/ui';
import { PauseIcon, PlayIcon } from '@phosphor-icons/react';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { CustomizeBoard, type CustomizeTab } from './customize-board';
import { FrameworkWindow, type FrameworkFocus } from './framework-window';
import { SessionWindow } from './session-window';

/** The 1-based line range of a top-level kortix.yaml block, up to the next top-level key. */
function block(key: string): FrameworkFocus {
  const lines: readonly string[] = MANIFEST;
  const from = lines.indexOf(`${key}:`);
  let to = lines.findIndex((line, i) => i > from && /^[a-z]/.test(line));
  if (to < 0) to = lines.length;
  while (!lines[to - 1]?.trim()) to--;
  return { file: 'kortix.yaml', from: from + 1, to };
}

const LAST_TRIGGER = MANIFEST.indexOf('  - slug: weekly-post') + 1;

type Step = { label: string; tab?: CustomizeTab; focus?: FrameworkFocus };

/** Two modes, four steps each, played in one loop of eight. */
const MODES: { label: string; steps: Step[] }[] = [
  {
    label: 'Workspace',
    steps: [
      { label: 'Describe your goal' },
      { label: 'Connect your tools', tab: 'Connectors' },
      { label: 'Automate work 24/7', tab: 'Triggers' },
      { label: 'Share with your team', tab: 'Review' },
    ],
  },
  {
    label: 'Framework',
    steps: [
      { label: 'Agents as code', focus: block('agents') },
      { label: 'Connectors and policies', focus: block('connectors') },
      { label: 'Triggers run 24/7', focus: block('triggers') },
      {
        label: 'Ship and review',
        focus: { file: 'kortix.yaml', from: LAST_TRIGGER, to: MANIFEST.length },
      },
    ],
  },
];

const PER_MODE = 4;
const TOTAL = MODES.length * PER_MODE;
/** How long each step shows, in ms. The session script needs ~5 s of it. */
const STEP_MS = 7500;

/**
 * The hero walkthrough: one Northwind project, played step by step like a
 * film. Workspace (what people use) runs four steps, then Framework (the same
 * project as code) runs four, then it loops. The switcher above jumps to a
 * mode; the strip below jumps to a step, and its active cell's line is the
 * timer. Pause, or opening a file in the framework view, holds the step.
 * With reduced motion nothing advances on its own and the strip has no timer.
 */
export function WorkspaceFramework() {
  const [index, setIndex] = useState(0);
  // Bumped on each return to step 1, so the session script plays again.
  const [lap, setLap] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = Boolean(useReducedMotion());
  const bar = useRef<HTMLSpanElement>(null);
  const timer = useRef<Animation | null>(null);

  const mode = Math.floor(index / PER_MODE);
  const step = index % PER_MODE;
  const current = MODES[mode].steps[step];
  const layer = index === 0 ? 'session' : mode === 0 ? 'customize' : 'framework';

  const select = (next: number) => {
    if (next === 0 && index !== 0) setLap((n) => n + 1);
    setIndex(next);
  };

  // The line is the timer: when its fill finishes, the next step shows.
  useEffect(() => {
    const el = bar.current;
    if (!el || reduced) return;
    const fill = el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
      duration: STEP_MS,
      easing: 'linear',
      fill: 'forwards',
    });
    fill.onfinish = () => {
      const next = (index + 1) % TOTAL;
      if (next === 0) setLap((n) => n + 1);
      setIndex(next);
    };
    timer.current = fill;
    return () => fill.cancel();
  }, [index, reduced]);

  // Runs after the effect above, so a step picked while paused stays paused.
  useEffect(() => {
    if (paused) timer.current?.pause();
    else timer.current?.play();
  }, [paused, index]);

  const shown = (name: typeof layer) =>
    cn('duration-slower transition-opacity ease-out', layer === name ? 'opacity-100' : 'pointer-events-none opacity-0');

  return (
    <div className="flex w-full flex-col items-center gap-4">
      <div role="group" aria-label="View" className="bg-muted flex items-center rounded-md p-0.5">
        {MODES.map((m, i) => (
          <button
            key={m.label}
            type="button"
            aria-pressed={mode === i}
            onClick={() => select(i * PER_MODE)}
            className="text-muted-foreground hover:text-foreground aria-pressed:bg-background aria-pressed:text-foreground outline-ring duration-moderate flex h-7 items-center rounded-sm px-3 text-xs font-medium transition-colors focus-visible:outline-2"
          >
            {m.label}
          </button>
        ))}
      </div>

      <div className="flex w-full flex-col gap-2">
        <div className="relative w-full">
          <div className={shown('session')} inert={layer !== 'session'}>
            <SessionWindow key={lap} />
          </div>
          <div className={cn('absolute inset-0', shown('customize'))} inert={layer !== 'customize'}>
            <CustomizeBoard tab={current.tab ?? 'Connectors'} />
          </div>
          <div className={cn('absolute inset-0', shown('framework'))} inert={layer !== 'framework'}>
            <FrameworkWindow
              focus={mode === 1 ? current.focus : undefined}
              shipped={index === TOTAL - 1}
              onInteract={() => setPaused(true)}
            />
          </div>
        </div>

        <ol
          aria-label={`${MODES[mode].label} steps`}
          className="bg-background mx-2 flex overflow-hidden rounded-lg border"
        >
          {MODES[mode].steps.map((s, i) => {
            const active = i === step;
            return (
              <li
                key={s.label}
                className={cn('relative flex min-w-0 border-r last:border-r-0', active ? 'flex-[3] sm:flex-1' : 'flex-1')}
              >
                <button
                  type="button"
                  aria-current={active ? 'step' : undefined}
                  onClick={() => select(mode * PER_MODE + i)}
                  className={cn(
                    'outline-ring hover:text-foreground flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 sm:px-4',
                    active ? 'text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <span className="text-muted-foreground font-mono text-xs tabular-nums">{i + 1}</span>
                  <span className={cn('truncate', !active && 'hidden sm:inline')}>{s.label}</span>
                </button>
                {active && !reduced ? (
                  <button
                    type="button"
                    onClick={() => setPaused(!paused)}
                    aria-label={paused ? 'Play' : 'Pause'}
                    className="text-muted-foreground hover:text-foreground outline-ring flex shrink-0 items-center pr-3 pl-1 transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2"
                  >
                    {paused ? <PlayIcon weight="fill" className="size-3" /> : <PauseIcon weight="fill" className="size-3" />}
                  </button>
                ) : null}
                {active ? (
                  <span aria-hidden className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
                    <span
                      ref={bar}
                      className="bg-foreground block size-full origin-left"
                      style={{ transform: reduced ? 'scaleX(1)' : 'scaleX(0)' }}
                    />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
