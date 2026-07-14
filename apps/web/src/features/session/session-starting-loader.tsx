'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import {
  Stepper,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
} from '@/components/ui/stepper';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { errorToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import {
  restartProjectSession,
  sessionStartKey,
  type SessionStartStage,
} from '@kortix/sdk/projects-client';
import { formatDuration } from '@kortix/sdk/turns';
import { CheckCircleSolid } from '@mynaui/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

/**
 * The ONE loader shown while a session's Kortix Computer comes up — full-screen
 * for resumes, and dead-center in the side panel while a fresh session boots.
 * All the heavy lifting (provision / wake / OpenCode readiness + pin) is
 * server-side behind POST /sessions/:id/start; this just reports the real stage.
 *
 * Visual: super-minimal, perfectly centered. A single kortix-green pulse, the
 * heading, a clean stepped checklist (no connector rails), and one quiet hint.
 */
const LOADER_DELAY_MS = 100;
/**
 * How long we sit in the backend `starting` stage before softly advancing from
 * "Preparing your workspace" to "Starting the agent". Both happen within that
 * one backend stage (clone → OpenCode boot), so the advance reflects real order.
 */
const STARTING_SUBSTEP_MS = 5_000;
/** After this long, swap the footer copy to set expectations for a cold start. */
const SLOW_AFTER_MS = 15_000;
/**
 * After this long, offer a manual restart. Sandboxes occasionally wedge (e.g. a
 * stuck provider-side proxy) with no server-side signal that anything is wrong —
 * a stop/start of the sandbox is the known fix, so surface it as a fallback
 * instead of leaving the user staring at "Connecting" indefinitely.
 */
const STUCK_AFTER_MS = 45_000;

interface Step {
  label: string;
  description: string;
}

/**
 * How the boot steps are laid out:
 * - `default`  — the full four-step vertical checklist (side-panel resume loader
 *                + inline thread checklist). Every step is visible; earlier ones
 *                tick to a green check as the boot advances.
 * - `switcher` — a single line showing ONLY the current step. When a step
 *                completes it swaps straight to the next with no transition, so
 *                the right-side action panel reads as one quiet status message
 *                advancing ("Provisioning…" → "Preparing…" → …) rather than a
 *                four-row list. The swap is intentionally instant: a crossfade
 *                between two one-liners reads as two objects, not one advancing.
 */
type BootStepVariant = 'default' | 'stepper';

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

/**
 * The shared boot clock: a 1s tick that resolves the CURRENT active step from
 * the backend stage plus time-in-stage (so the `starting` soft-advance fires),
 * and exposes `now` for any caller-side elapsed/slow/stuck math. Both the side
 * panel loader and the inline thread checklist consume this, so the two always
 * report the same step.
 */
function useBootProgress(stage: SessionStartStage): { active: number; now: number } {
  const [now, setNow] = useState(() => Date.now());
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

  return { active: activeStep(stage, now - stageEnteredAt.current), now };
}

/**
 * The dotted-ring glyph in two states: `spinning` (kortix-green, rotating, with
 * a solid center — the in-progress step) and idle (muted, static). Shared by the
 * default checklist's active/pending rows and the switcher's single row so the
 * in-progress indicator is pixel-identical across both variants.
 */
function StepRing({ spinning }: { spinning: boolean }) {
  return (
    <svg
      height="16"
      viewBox="0 0 16 16"
      width="16"
      strokeLinejoin="round"
      style={{ color: spinning ? 'var(--kortix-green)' : 'var(--muted-foreground)' }}
      className={cn(
        'relative flex shrink-0 items-center justify-center',
        spinning && 'animate-spin',
      )}
      aria-hidden
    >
      <circle
        cx="8"
        cy="8"
        r="6.3"
        stroke="currentColor"
        fill="none"
        strokeWidth="1.5"
        strokeDasharray="3 3.4"
      />
      {spinning ? <circle cx="8" cy="8" r="4" fill="currentColor" /> : null}
    </svg>
  );
}

/** The in-progress step's label, with the kortix shimmer sweeping across it. */
function StepLabelShimmer({ label }: { label: string }) {
  return (
    <TextShimmer
      as="span"
      duration={1.8}
      spread={1.25}
      className="text-[13px] leading-none font-medium tracking-tight"
    >
      {label}
    </TextShimmer>
  );
}

/**
 * The stepped checklist itself — one render, shared by the centered panel loader
 * and the inline thread checklist so they can never visually drift. Pure: the
 * caller owns the clock (see {@link useBootProgress}) and passes the active index.
 *
 * `variant` picks the layout (see {@link BootStepVariant}): the default renders
 * the whole four-row checklist; `switcher` renders just the current step's row,
 * swapping instantly to the next as the boot advances.
 */
function BootStepList({
  active,
  variant = 'default',
}: {
  active: number;
  variant?: BootStepVariant;
}) {
  if (variant === 'default') {
    // Only ever the CURRENT step. `active` never exceeds the last index (see
    // activeStep), but clamp defensively so the row is always resolvable.
    const step = STEPS[Math.min(active, STEPS.length - 1)];
    return (
      <div className="flex h-4 min-w-0 items-center">
        <StepLabelShimmer key={step.label} label={step.label} />
      </div>
    );
  }

  return (
    <Stepper
      value={active}
      orientation="vertical"
      count={STEPS.length - 1}
      className="w-auto"
      aria-live="polite"
    >
      {STEPS.map((step, i) => {
        const done = i < active;
        const current = i === active;
        return (
          <div key={step.label} className="flex items-start gap-2.5">
            <StepperItem
              step={i}
              className="items-center"
              aria-current={current ? 'step' : undefined}
            >
              <StepperIndicator className="flex size-3.5 shrink-0 items-center justify-center rounded-none bg-none text-current">
                {done ? (
                  <CheckCircleSolid
                    className="text-kortix-green bg-background size-3.5"
                    strokeWidth={2.5}
                  />
                ) : (
                  <StepRing spinning={current} />
                )}
              </StepperIndicator>
              <StepperSeparator className="bg-border group-data-[state=completed]/step:bg-kortix-green/40 m-0 my-0.5 group-data-[orientation=vertical]/stepper:min-h-3" />
            </StepperItem>
            <div className="flex h-4 min-w-0 items-center">
              {current ? (
                <StepLabelShimmer label={step.label} />
              ) : (
                <StepperTitle className="text-muted-foreground/50 text-[13px] leading-none tracking-tight transition-colors duration-500">
                  {step.label}
                </StepperTitle>
              )}
            </div>
          </div>
        );
      })}
    </Stepper>
  );
}

export function SessionStartingLoader({
  stage = 'provisioning',
  /** Delay before the content fades in. The full-screen resume loader keeps the
   *  default so a warm open never flashes it; the side panel passes 0 because the
   *  user opened it deliberately and expects to see status immediately. */
  delayMs = LOADER_DELAY_MS,
  /** When both are given, a "Restart session" fallback appears once the boot
   *  has clearly stalled (see STUCK_AFTER_MS). Omit either to hide it — some
   *  embeddings of this loader don't have a project session id in scope. */
  projectId,
  sessionId,
  /** Checklist layout. The full-screen resume loader keeps the default
   *  four-step stepper; the side action panel passes `switcher` so it shows a
   *  single status line advancing one step at a time. */
  variant = 'stepper',
}: {
  stage?: SessionStartStage;
  delayMs?: number;
  projectId?: string;
  sessionId?: string;
  variant?: BootStepVariant;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [show, setShow] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) {
      setShow(true);
      return;
    }
    const t = setTimeout(() => setShow(true), delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);

  // The shared boot clock owns the 1s tick + per-stage soft-advance; `now` also
  // drives the footer copy below (and the inline checklist reuses the same hook).
  const { active, now } = useBootProgress(stage);
  // A manual restart pushes the "stuck" clock back out so the button doesn't
  // reappear immediately while the fresh boot is still in progress.
  const clockStart = useRef(now);
  const slow = now - clockStart.current >= SLOW_AFTER_MS;
  const stuck = now - clockStart.current >= STUCK_AFTER_MS;
  const canRestart = !!projectId && !!sessionId;

  const restartMutation = useMutation({
    mutationFn: () => restartProjectSession(projectId!, sessionId!),
    onSuccess: () => {
      clockStart.current = Date.now();
      queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId!, sessionId!) });
      queryClient.invalidateQueries({
        queryKey: ['project', 'session-sandbox', projectId, sessionId],
      });
    },
    onError: (err) => {
      errorToast(err instanceof Error ? err.message : 'Failed to restart session');
    },
  });

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
        <BootStepList active={active} variant={variant} />

        <p className="text-muted-foreground text-center text-[11px] leading-relaxed">
          {slow ? 'A cold start can take a little longer.' : 'This usually takes a few seconds.'}
        </p>

        {stuck && canRestart ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 rounded-full px-3 text-[11px]"
            disabled={restartMutation.isPending}
            onClick={() => restartMutation.mutate()}
          >
            {restartMutation.isPending ? (
              <Loading className="size-3 shrink-0 text-current" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
            {restartMutation.isPending ? 'Restarting…' : 'Taking too long? Restart session'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The boot checklist rendered INLINE in the thread (under the assistant
 * logomark) while a freshly-created session's Kortix Computer comes up — the
 * SAME stepped progress as the side panel's {@link SessionStartingLoader}, via
 * the shared {@link BootStepList} + {@link useBootProgress}, so a user who never
 * opens the computer panel still watches the real provisioning state advance
 * instead of one static "Provisioning…" line. Left-aligned to sit under the
 * Kortix logomark; carries its own elapsed timer to match the thread's regular
 * waiting indicator.
 */
export function SessionBootChecklistInline({
  stage = 'provisioning',
  className,
}: {
  stage?: SessionStartStage;
  className?: string;
}) {
  const { active, now } = useBootProgress(stage);
  const startRef = useRef(now);
  const elapsed = formatDuration(now - startRef.current);
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div aria-label="Starting your Kortix Computer">
        <BootStepList active={active} />
      </div>
      {elapsed ? (
        <span className="text-muted-foreground text-[13px] tabular-nums">· {elapsed}</span>
      ) : null}
    </div>
  );
}
