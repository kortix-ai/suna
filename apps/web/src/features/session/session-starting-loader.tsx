'use client';

import { Check, Loader2, RotateCcw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { restartProjectSession, sessionStartKey, type SessionStartStage } from '@kortix/sdk/projects-client';
import { formatDuration } from '@kortix/sdk/turns';
import { Button } from '@/components/ui/button';
import { errorToast } from '@/components/ui/toast';
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
 * The stepped checklist itself — one render, shared by the centered panel loader
 * and the inline thread checklist so they can never visually drift. Pure: the
 * caller owns the clock (see {@link useBootProgress}) and passes the active index.
 */
function BootStepList({ active }: { active: number }) {
  return (
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
}: {
  stage?: SessionStartStage;
  delayMs?: number;
  projectId?: string;
  sessionId?: string;
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
        <BootStepList active={active} />

        <p className="text-muted-foreground/40 text-center text-[11px] leading-relaxed">
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
              <Loader2 className="h-3 w-3 animate-spin" />
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
    <div className={cn('flex flex-col items-start gap-2', className)}>
      <div
        className="bg-popover w-full rounded-2xl border px-4.5 py-4"
        aria-label="Starting your Kortix Computer"
      >
        <BootStepList active={active} />
      </div>
      {elapsed ? (
        <span className="text-muted-foreground/50 pl-1 text-xs tabular-nums">· {elapsed}</span>
      ) : null}
    </div>
  );
}
