'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { restartProjectSession, sessionStartKey, type SessionStartStage } from '@kortix/sdk';
import { qk } from '@kortix/sdk/react';
import { ArrowCounterClockwiseIcon as RotateCcw } from '@phosphor-icons/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

/**
 * The ONE loader shown while a session's Kortix Computer comes up — full-screen
 * for resumes, and dead-center in the side panel while a fresh session boots.
 * All the heavy lifting (provision / wake / OpenCode readiness + pin) is
 * server-side behind POST /sessions/:id/start; this just reports the real stage.
 *
 * Visual: one stable heading, one short stage label, one four-stage rail, and
 * one small spinner. The spinner is the only perpetual motion. The rail moves
 * only when the backend stage advances, so it never claims progress we do not
 * have.
 */
const LOADER_DELAY_MS = 100;
/**
 * How long we sit in the backend `starting` stage before softly advancing from
 * "Loading your workspace" to "Waking the agent". Both happen within that one
 * backend stage (clone → OpenCode boot), so the advance reflects real order.
 */
const STARTING_SUBSTEP_MS = 5_000;
/** After this long, show copy that sets expectations for a cold start. */
const SLOW_AFTER_MS = 15_000;
/**
 * After this long, offer a manual restart. Sandboxes occasionally wedge (e.g. a
 * stuck provider-side proxy) with no server-side signal that anything is wrong —
 * a stop/start of the sandbox is the known fix, so surface it as a fallback
 * instead of leaving the user staring at "Connecting" indefinitely.
 */
export const STUCK_AFTER_MS = 45_000;

interface Step {
  /** User-visible label for the active startup stage. */
  label: string;
}

/**
 * Accepted for input compatibility. Both values intentionally render the same
 * loader.
 */
type BootStepVariant = 'stepper' | 'compact';

/** Copy is deliberately parallel, so stage changes read as one continuous task. */
export const STEPS: Step[] = [
  { label: 'Reserving your computer' },
  { label: 'Loading your workspace' },
  { label: 'Waking the agent' },
  { label: 'Connecting' },
];

/**
 * Resolve which step is CURRENTLY active from the backend stage plus how long
 * we've been in it. The index is the floor we KNOW we're at — earlier steps are
 * genuinely complete, later ones haven't started.
 */
export function activeStep(stage: SessionStartStage, msInStage: number): number {
  if (stage === 'provisioning') return 0;
  if (stage === 'starting') return msInStage >= STARTING_SUBSTEP_MS ? 2 : 1;
  return 3;
}

/**
 * The shared boot clock: a 1s tick that resolves the current active step from
 * the backend stage plus time-in-stage, and exposes `now` for elapsed-time UI.
 */
function useBootProgress(stage: SessionStartStage): { active: number; now: number } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const [stageEnteredAt, setStageEnteredAt] = useState(now);
  const [prevStage, setPrevStage] = useState(stage);
  if (prevStage !== stage) {
    setPrevStage(stage);
    setStageEnteredAt(now);
  }

  return { active: activeStep(stage, now - stageEnteredAt), now };
}

/** The stalled-boot escape hatch, shared by the loader and instant session shell. */
export function RestartFallback({
  show,
  pending,
  onRestart,
  className,
  buttonClassName,
}: {
  show: boolean;
  pending: boolean;
  onRestart: () => void;
  className?: string;
  buttonClassName?: string;
}) {
  if (!show) return null;

  return (
    <div className={cn('mt-5 w-full', className)}>
      <p className="text-muted-foreground mb-2 text-xs text-pretty">
        This is taking longer than usual.
      </p>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className={cn('w-full active:scale-[0.96]', buttonClassName)}
        disabled={pending}
        onClick={onRestart}
      >
        {pending ? (
          <Loading className="size-3.5 shrink-0 text-current motion-reduce:animate-none" />
        ) : (
          <RotateCcw className="size-3.5 shrink-0" />
        )}
        {pending ? 'Restarting…' : 'Restart session'}
      </Button>
    </div>
  );
}

interface QuietProgressLoaderProps {
  active: number;
  canRestart: boolean;
  note?: string | null;
  onRestart: () => void;
  pending: boolean;
  show: boolean;
  slow: boolean;
  stuck: boolean;
}

/**
 * One stable headline, one source of perpetual motion, and an honest four-stage
 * rail. Progress changes immediately when the backend stage changes.
 */
function QuietProgressLoader({
  active,
  canRestart,
  note,
  onRestart,
  pending,
  show,
  slow,
  stuck,
}: QuietProgressLoaderProps) {
  const step = STEPS[Math.min(active, STEPS.length - 1)];

  return (
    <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center px-4 sm:px-8">
      {show ? (
        <div role="status" aria-live="polite" className="flex w-full max-w-xs items-start gap-3">
          <Loading
            variant="spokes"
            className="text-muted-foreground mt-0.5 size-4 shrink-0 motion-reduce:animate-none"
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-foreground text-sm font-medium text-balance">
              Starting your session
            </h2>
            <p className="text-muted-foreground mt-1 text-xs text-pretty">{note ?? step.label}</p>

            <div
              role="progressbar"
              aria-label="Session startup progress"
              aria-valuemin={1}
              aria-valuemax={STEPS.length}
              aria-valuenow={active + 1}
              aria-valuetext={`Step ${active + 1} of ${STEPS.length}: ${step.label}`}
              className="mt-3 grid grid-cols-4 gap-1.5"
            >
              {STEPS.map((item, index) => (
                <span
                  key={item.label}
                  aria-hidden
                  className={cn(
                    'h-1 rounded-full',
                    index <= active ? 'bg-kortix-green' : 'bg-border/70',
                  )}
                />
              ))}
            </div>

            {slow ? (
              <p className="text-muted-foreground mt-3 text-xs text-pretty">
                Cold starts can take a little longer.
              </p>
            ) : null}

            <RestartFallback show={stuck && canRestart} pending={pending} onRestart={onRestart} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SessionStartingLoader({
  stage = 'provisioning',
  /** Delay before the content appears. Warm opens avoid flashing the loader. */
  delayMs = LOADER_DELAY_MS,
  projectId,
  sessionId,
  /** Honest one-liner from the SDK wake escalation ladder. */
  note,
}: {
  stage?: SessionStartStage;
  delayMs?: number;
  projectId?: string;
  sessionId?: string;
  variant?: BootStepVariant;
  note?: string | null;
}) {
  const queryClient = useQueryClient();
  const [delayElapsed, setDelayElapsed] = useState(false);
  const show = delayMs <= 0 || delayElapsed;
  useEffect(() => {
    if (delayMs <= 0) return;
    const timeout = setTimeout(() => setDelayElapsed(true), delayMs);
    return () => clearTimeout(timeout);
  }, [delayMs]);

  const { active, now } = useBootProgress(stage);
  const [clockStart, setClockStart] = useState(now);
  const slow = now - clockStart >= SLOW_AFTER_MS;
  const stuck = now - clockStart >= STUCK_AFTER_MS;
  const canRestart = !!projectId && !!sessionId;

  const restartMutation = useMutation({
    mutationFn: () => restartProjectSession(projectId!, sessionId!),
    onSuccess: () => {
      setClockStart(Date.now());
      queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId!, sessionId!) });
      queryClient.invalidateQueries({
        queryKey: qk.project.sessionSandbox(projectId ?? '', sessionId ?? ''),
      });
    },
    onError: (error) => {
      errorToast(error instanceof Error ? error.message : 'Failed to restart session');
    },
  });

  return (
    <QuietProgressLoader
      active={active}
      canRestart={canRestart}
      note={note}
      onRestart={() => restartMutation.mutate()}
      pending={restartMutation.isPending}
      show={show}
      slow={slow}
      stuck={stuck}
    />
  );
}

/**
 * Compact status above a readable conversation while its runtime wakes. The
 * transcript remains scrollable because only the restart control accepts input.
 */
export function SessionConnectingBanner({
  stage = 'provisioning',
  projectId,
  sessionId,
  className,
  note,
}: {
  stage?: SessionStartStage;
  projectId?: string;
  sessionId?: string;
  className?: string;
  note?: string | null;
}) {
  const queryClient = useQueryClient();
  const { active, now } = useBootProgress(stage);
  const [clockStart, setClockStart] = useState(now);
  const stuck = now - clockStart >= STUCK_AFTER_MS;
  const canRestart = !!projectId && !!sessionId;
  const step = STEPS[Math.min(active, STEPS.length - 1)];

  const restartMutation = useMutation({
    mutationFn: () => restartProjectSession(projectId!, sessionId!),
    onSuccess: () => {
      setClockStart(Date.now());
      queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId!, sessionId!) });
      queryClient.invalidateQueries({
        queryKey: qk.project.sessionSandbox(projectId ?? '', sessionId ?? ''),
      });
    },
    onError: (error) => {
      errorToast(error instanceof Error ? error.message : 'Failed to restart session');
    },
  });

  return (
    <div
      role="status"
      aria-live="polite"
      data-session-connecting-banner=""
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center px-3 pt-3',
        className,
      )}
    >
      <div className="bg-background/85 text-muted-foreground flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs shadow-xs backdrop-blur-sm">
        <Loading
          variant="spokes"
          className="size-3.5 shrink-0 text-current motion-reduce:animate-none"
        />
        <span className="truncate">{note ?? step.label}</span>
        {stuck && canRestart ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-events-auto -mr-2 h-6 px-2 text-xs"
            disabled={restartMutation.isPending}
            onClick={() => restartMutation.mutate()}
          >
            {restartMutation.isPending ? 'Restarting…' : 'Restart'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
