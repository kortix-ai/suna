'use client';

import { cn } from '@kortix/ui';
import { PauseIcon, PlayIcon } from '@phosphor-icons/react';
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';

import { FrameworkWindow } from './framework-window';
import { SessionWindow } from './session-window';

const STEPS = [
  { label: 'Workspace', sub: 'Your team works here' },
  { label: 'Framework', sub: 'Everything underneath is code' },
] as const;

/** How long each view shows before the next one, in ms. */
const DWELL = 9000;

/**
 * One Northwind project, two views, switched on a timer: the workspace people
 * use, then the same project as code. A step's bar fills while it shows;
 * clicking a step jumps to it, and Pause holds the current one. With reduced
 * motion nothing advances on its own.
 */
export function WorkspaceFramework() {
  const [step, setStep] = useState(0);
  const [pausedByReader, setPaused] = useState(false);
  const reduced = useReducedMotion();
  const paused = pausedByReader || Boolean(reduced);
  const bar = useRef<HTMLSpanElement>(null);

  // The bar is the timer: when its fill finishes, the next view shows.
  useEffect(() => {
    const el = bar.current;
    if (!el || paused) return;
    const fill = el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], {
      duration: DWELL,
      easing: 'linear',
      fill: 'forwards',
    });
    fill.onfinish = () => setStep((s) => (s + 1) % STEPS.length);
    return () => fill.cancel();
  }, [step, paused]);

  return (
    <div className="flex w-full flex-col">
      <div className="relative w-full">
        <div className={cn('duration-slower transition-opacity ease-out', step === 0 ? 'opacity-100' : 'opacity-0')}>
          <SessionWindow />
        </div>
        <div
          className={cn(
            'duration-slower absolute inset-0 transition-opacity ease-out',
            step === 1 ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        >
          <FrameworkWindow />
        </div>
      </div>

      <div className="bg-background mx-2 mt-3 flex overflow-hidden rounded-lg border" role="tablist" aria-label="Workspace and framework">
        {STEPS.map((s, i) => (
          <button
            key={s.label}
            type="button"
            role="tab"
            aria-selected={step === i}
            onClick={() => setStep(i)}
            className="outline-ring relative flex min-w-0 flex-1 items-center gap-3 border-r px-4 py-3 text-left last:border-r-0 focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <span className="text-muted-foreground font-mono text-xs tabular-nums">{i + 1}</span>
            <span className="flex min-w-0 flex-col">
              <span className={cn('text-sm font-medium', step === i ? 'text-foreground' : 'text-muted-foreground')}>
                {s.label}
              </span>
              <span className="text-muted-foreground hidden truncate text-xs sm:block">{s.sub}</span>
            </span>
            {step === i ? (
              <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
                <span
                  ref={bar}
                  className="bg-foreground block size-full origin-left"
                  style={{ transform: paused ? 'scaleX(1)' : 'scaleX(0)' }}
                />
              </span>
            ) : null}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setPaused(!paused)}
          aria-label={paused ? 'Play' : 'Pause'}
          className="text-muted-foreground hover:text-foreground outline-ring flex shrink-0 items-center px-4 focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          {paused ? <PlayIcon className="size-4" /> : <PauseIcon className="size-4" />}
        </button>
      </div>
    </div>
  );
}
