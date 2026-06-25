'use client';

import { Check, Spinner as Loader2 } from '@mynaui/icons-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import type { SessionStartStage } from '@/lib/projects-client';
import { cn } from '@/lib/utils';

/**
 * The ONE loader shown while a session's Kortix Computer comes up — full-screen
 * for resumes, and dead-center in the side panel while a fresh session boots.
 * All the heavy lifting (provision / wake / OpenCode readiness + pin) is
 * server-side behind POST /sessions/:id/start; this just reports the real stage.
 *
 * Visual: super-minimal, perfectly centered. A single kortix-green pulse, the
 * heading, a clean stepped checklist (no connector rails), and one quiet hint.
 */
const LOADER_DELAY_MS = 700;
/**
 * How long we sit in the backend `starting` stage before softly advancing from
 * "Preparing your workspace" to "Starting the agent". Both happen within that
 * one backend stage (clone → OpenCode boot), so the advance reflects real order.
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
  /** Delay before the content fades in. The full-screen resume loader keeps the
   *  default so a warm open never flashes it; the side panel passes 0 because the
   *  user opened it deliberately and expects to see status immediately. */
  delayMs = LOADER_DELAY_MS,
}: {
  stage?: SessionStartStage;
  delayMs?: number;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const [show, setShow] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) {
      setShow(true);
      return;
    }
    const t = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);

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
    <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center px-8">
      <div
        className={cn(
          'flex flex-col items-center gap-9 transition-opacity duration-500',
          show ? 'opacity-100' : 'opacity-0',
        )}
      >
        {/* Brand heartbeat + heading, grouped. */}
        <div className="flex flex-col items-center gap-4">
          <span className="relative flex h-2.5 w-2.5" aria-hidden>
            <span className="bg-kortix-green/40 absolute inline-flex h-full w-full animate-ping rounded-full" />
            <span className="bg-kortix-green relative inline-flex h-2.5 w-2.5 rounded-full" />
          </span>
          <h2 className="text-foreground text-[13px] font-medium tracking-tight">
            {tI18nHardcoded.raw(
              'autoFeaturesSessionSessionStartingLoaderJsxTextKortixComputerIs7c42f59a',
            )}
          </h2>
        </div>

        {/* Auto-width so the checklist is a centered block under the heading. */}
        <ol className="flex flex-col gap-3.5" aria-live="polite">
          {STEPS.map((step, i) => {
            const done = i < active;
            const current = i === active;
            return (
              <li
                key={step.label}
                className="flex items-center gap-2.5"
                aria-current={current ? 'step' : undefined}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {done ? (
                    <Check className="text-kortix-green h-3.5 w-3.5" strokeWidth={2.5} />
                  ) : current ? (
                    <Loader2 className="text-kortix-green h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <span className="bg-muted-foreground/25 h-1 w-1 rounded-full" />
                  )}
                </span>
                <span
                  className={cn(
                    'text-[13px] leading-none tracking-tight transition-colors duration-500',
                    current
                      ? 'text-foreground font-medium'
                      : done
                        ? 'text-muted-foreground'
                        : 'text-muted-foreground/40',
                  )}
                >
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>

        <p className="text-muted-foreground/40 text-center text-[11px] leading-relaxed">
          {slow ? 'A cold start can take a little longer.' : 'This usually takes a few seconds.'}
        </p>
      </div>
    </div>
  );
}
