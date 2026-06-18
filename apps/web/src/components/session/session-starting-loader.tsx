'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { SessionStartStage } from '@/lib/projects-client';

/**
 * The ONE loader shown while a session's Kortix Computer comes up. All the heavy
 * lifting (provision / wake / OpenCode readiness + pin) is server-side behind
 * POST /sessions/:id/start — this just reports the real stage it returns.
 *
 * IMPORTANT — layout stability: the outer flex-1 container is ALWAYS rendered so
 * it always occupies the content area. Only the visible loader CONTENT is held
 * back ~700ms (so a warm open / transient re-render never flashes it). Returning
 * null instead collapsed the content area to zero height, which let the chat
 * input snap to the top and then jump back down — the janky "input jumps" bug.
 */
const LOADER_DELAY_MS = 700;
/**
 * How long we sit in the backend `starting` stage before softly advancing the
 * timeline from "Preparing your workspace" to "Starting the agent". Both happen
 * within that one backend stage (clone → OpenCode boot, in that order), so the
 * advance reflects real ordering — and we never mark the LAST sub-step done
 * until the backend actually reports `ready`.
 */
const STARTING_SUBSTEP_MS = 5_000;
/** After this long, swap the footer copy to set expectations for a cold start. */
const SLOW_AFTER_MS = 15_000;

interface Step {
  label: string;
  description: string;
}

const STEPS: Step[] = [
  { label: 'Provisioning your computer', description: 'Allocating a secure sandbox' },
  { label: 'Preparing your workspace', description: 'Cloning your project files' },
  { label: 'Starting the agent', description: 'Booting the runtime and tools' },
  { label: 'Connecting', description: 'Linking up your session' },
];

/**
 * Resolve which step is CURRENTLY active from the backend stage plus how long
 * we've been in it. The index is the floor we KNOW we're at — earlier steps are
 * genuinely complete, later ones haven't started.
 */
function activeStep(stage: SessionStartStage, msInStage: number): number {
  if (stage === 'provisioning') return 0;
  if (stage === 'starting') return msInStage >= STARTING_SUBSTEP_MS ? 2 : 1;
  return 3; // ready → the FE active-server switch + health poll ("connecting")
}

export function SessionStartingLoader({
  stage = 'provisioning',
}: {
  stage?: SessionStartStage;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), LOADER_DELAY_MS);
    return () => clearTimeout(t);
  }, []);

  // A 1s tick drives both the in-stage soft-advance and the footer copy.
  const [now, setNow] = useState(() => Date.now());
  const mountedAt = useRef(now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // Reset the per-stage clock whenever the backend stage changes, so the
  // soft-advance measures time spent in the CURRENT stage (not since mount).
  const stageEnteredAt = useRef(now);
  const prevStage = useRef(stage);
  if (prevStage.current !== stage) {
    prevStage.current = stage;
    stageEnteredAt.current = now;
  }

  const active = activeStep(stage, now - stageEnteredAt.current);
  const slow = now - mountedAt.current >= SLOW_AFTER_MS;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      {show && (
        <div className="flex w-full max-w-xs flex-col gap-6">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2" aria-hidden>
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-kortix-green/60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-kortix-green" />
            </span>
            <h2 className="text-foreground text-sm font-semibold">Kortix Computer is starting</h2>
          </div>

          <ol className="flex flex-col" aria-live="polite">
            {STEPS.map((step, i) => {
              const done = i < active;
              const current = i === active;
              const isLast = i === STEPS.length - 1;
              return (
                <li
                  key={step.label}
                  className="flex gap-3"
                  aria-current={current ? 'step' : undefined}
                >
                  {/* Node + connector rail */}
                  <div className="flex flex-col items-center">
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors duration-moderate',
                        done
                          ? 'border-kortix-green/30 bg-kortix-green/10 text-kortix-green'
                          : current
                            ? 'border-kortix-green/40 text-kortix-green'
                            : 'border-border bg-transparent',
                      )}
                    >
                      {done ? (
                        <Check className="h-3 w-3" strokeWidth={2.5} />
                      ) : current ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-border" />
                      )}
                    </span>
                    {!isLast && (
                      <span
                        className={cn(
                          'mt-1 w-px flex-1 transition-colors duration-moderate',
                          done ? 'bg-kortix-green/25' : 'bg-border',
                        )}
                      />
                    )}
                  </div>

                  {/* Label + description */}
                  <div className={cn('flex flex-col', isLast ? 'pb-0' : 'pb-4')}>
                    <span
                      className={cn(
                        'text-sm leading-5 transition-colors duration-moderate',
                        current
                          ? 'text-foreground font-medium'
                          : done
                            ? 'text-muted-foreground'
                            : 'text-muted-foreground/50',
                      )}
                    >
                      {step.label}
                    </span>
                    {current && (
                      <span className="text-muted-foreground/60 text-xs leading-5">
                        {step.description}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>

          <p className="text-muted-foreground/50 text-xs leading-relaxed">
            {slow
              ? 'Still preparing — a cold start can take a little longer than usual.'
              : 'This usually takes a few seconds while your workspace and files are prepared.'}
          </p>
        </div>
      )}
    </div>
  );
}
