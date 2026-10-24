'use client';

import { Button } from '../../primitives/button';
import Loading from '../../primitives/loading';
import { useRestartProjectSession } from '../../internal/hooks/projects/use-restart-project-session';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import { type SessionStartResult } from '@kortix/sdk';
import { useProjectSession } from '@kortix/sdk/react';
import { ArrowCounterClockwiseIcon as RotateCcw } from '@phosphor-icons/react';
import { useContext, useEffect, useRef, useState } from 'react';

import { TranscriptRowsContext } from '../thread/transcript-rows';

/**
 * What a session shows while its Kortix Computer comes up: nothing, unless the
 * wake needs attention. Opening a session wakes its computer in the background,
 * and a send goes out as soon as it is up, so a routine wake has nothing to
 * say. Two states speak: an escalation or retry note from the server, and a
 * wake stuck past `STUCK_AFTER_MS` that the caller may restart.
 *
 * All the heavy lifting (provision / wake / runtime readiness) is server-side
 * behind POST /sessions/:id/start.
 */

/**
 * After this long, offer a manual restart. Sandboxes occasionally wedge (e.g. a
 * stuck provider-side proxy) with no server-side signal that anything is wrong —
 * a stop/start of the sandbox is the known fix, so surface it as a fallback
 * instead of leaving the user waiting indefinitely.
 */
export const STUCK_AFTER_MS = 45_000;

type StartFailure = SessionStartResult['failure'];

/**
 * The longest retry clock worth counting down. The server's cooldown is 2, 5
 * or 10 minutes (`RUNTIME_START_RETRY_BACKOFF_MS`); a clock further away comes
 * from a skewed or unset `now`, and it rendered as tens of millions of minutes.
 */
const MAX_COUNTDOWN_SECONDS = 60 * 60;

/**
 * Keep the server's retry visible while `/start` waits for its retry clock.
 * The server re-attempts on its own, so this is a waiting state, not an error.
 */
export function sessionWakeStatusNote(input: {
  reason?: string | null;
  failure?: StartFailure;
  note?: string | null;
  now: number;
}): string | null {
  if (input.reason !== 'runtime_wake_cooldown' || !input.failure) return input.note ?? null;
  const attempts = Math.max(1, input.failure.evidence?.attempts ?? 1);
  const nextAttempt = attempts + 1;
  const retryAt = Date.parse(input.failure.evidence?.next_retry_at ?? '');
  const seconds = Math.max(0, Math.ceil((retryAt - input.now) / 1_000));
  if (!Number.isFinite(seconds) || seconds > MAX_COUNTDOWN_SECONDS) {
    return `Still starting your computer. Trying again automatically (attempt ${nextAttempt}).`;
  }
  if (seconds === 0) return `Still starting your computer. Trying again now (attempt ${nextAttempt}).`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  // One unit: a line break never falls between the minutes and the seconds.
  const duration = minutes > 0 ? `${minutes}m\u00a0${remainder}s` : `${remainder}s`;
  return `Still starting your computer. Trying again in ${duration} (attempt ${nextAttempt}).`;
}

/** A 1 s tick: the retry countdown and the stuck clock read it. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * The boot clock a restart carries. The shared restart hook owns the whole
 * mutation, so the success signal this file used to read out of a hand-rolled
 * `onSuccess` is the hook's own state: its `errorMessage` is null exactly when
 * a settled restart succeeded, so a pending→idle edge without an error resets
 * the clock. A rejected restart keeps the old clock, so the stuck fallback
 * stays available for a retry.
 */
function useRestartedBootClock(restart: {
  isPending: boolean;
  errorMessage: string | null;
}): number {
  const [clockStart, setClockStart] = useState(() => Date.now());
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !restart.isPending && !restart.errorMessage) {
      setClockStart(Date.now());
    }
    wasPending.current = restart.isPending;
  }, [restart.isPending, restart.errorMessage]);
  return clockStart;
}

/**
 * Whether the stuck-boot restart offer may render. Restart is the session
 * owner's or a project manager's; the server answers anyone else 403
 * (`can_manage_lifecycle`, the same verdict every session menu follows). A
 * member who can open the session still gets the loader, just without the
 * escape hatch. An absent row cannot deny yet: a fresh session's row arrives
 * with the boot that wedged.
 */
export function canOfferBootRestart(
  session: { can_manage_lifecycle?: boolean } | undefined,
  projectId?: string,
  sessionId?: string,
): boolean {
  return Boolean(projectId && sessionId) && session?.can_manage_lifecycle !== false;
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // A channel's thread panel says "thread", not "session" (`TranscriptRows.labels`).
  const labels = useContext(TranscriptRowsContext)?.labels;
  if (!show) return null;

  return (
    <div className={cn('mt-5 w-full', className)}>
      <p className="text-muted-foreground mb-2 text-xs text-pretty">
        {tI18nComplete.raw('textbeda94e911d3')}
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
        {pending ? tI18nComplete.raw('text75d0f1469d16') : (labels?.restart ?? tI18nComplete.raw('textcb886371afc6'))}
      </Button>
    </div>
  );
}

/**
 * The wake's status where nothing else can paint: the side panel, a chat with
 * no runtime yet, a resume with nothing saved. A routine wake renders nothing.
 */
export function SessionStartingLoader({
  projectId,
  sessionId,
  /** Honest one-liner from the SDK wake escalation ladder. */
  note,
  reason,
  failure,
}: {
  projectId?: string;
  sessionId?: string;
  note?: string | null;
  reason?: string | null;
  failure?: StartFailure;
}) {
  const { data: session } = useProjectSession(projectId, sessionId);
  const restart = useRestartProjectSession(projectId ?? '', sessionId ?? '');
  const now = useNow();
  const statusNote = sessionWakeStatusNote({ reason, failure, note, now });
  const clockStart = useRestartedBootClock(restart);
  const restartable =
    now - clockStart >= STUCK_AFTER_MS && canOfferBootRestart(session, projectId, sessionId);

  if (!statusNote && !restartable) return null;
  return (
    <div className="flex h-full min-h-0 w-full flex-1 items-center justify-center px-4 sm:px-8">
      <div role="status" aria-live="polite" className="flex w-full max-w-xs items-start gap-3">
        <Loading
          variant="spokes"
          className="text-muted-foreground mt-0.5 size-4 shrink-0 motion-reduce:animate-none"
        />
        <div className="min-w-0 flex-1">
          {statusNote ? <p className="text-muted-foreground text-xs text-pretty">{statusNote}</p> : null}
          <RestartFallback
            show={restartable}
            pending={restart.isPending}
            onRestart={restart.restart}
            className={statusNote ? 'mt-3' : 'mt-0'}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Compact status above a readable conversation while its runtime wakes, shown
 * only when the wake needs attention: an escalation or retry note, or a stuck
 * wake with a Restart. A normal wake renders nothing. The transcript remains
 * scrollable because only the restart control accepts input.
 */
export function SessionConnectingBanner({
  projectId,
  sessionId,
  className,
  note,
  reason,
  failure,
}: {
  projectId?: string;
  sessionId?: string;
  className?: string;
  note?: string | null;
  reason?: string | null;
  failure?: StartFailure;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const { data: session } = useProjectSession(projectId, sessionId);
  const restart = useRestartProjectSession(projectId ?? '', sessionId ?? '');
  const now = useNow();
  const statusNote = sessionWakeStatusNote({ reason, failure, note, now });
  const clockStart = useRestartedBootClock(restart);
  const stuck = now - clockStart >= STUCK_AFTER_MS;
  const canRestart = canOfferBootRestart(session, projectId, sessionId);
  // A normal wake is silent: opening the session wakes its computer in the
  // background, and a send goes out as soon as it is up. The pill speaks only
  // when something is wrong: the wake escalated or waits on a retry
  // (`statusNote`), or it is stuck and can be restarted.
  if (!statusNote && !(stuck && canRestart)) return null;

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
        <span className="min-w-0 text-pretty">
          {statusNote ?? tI18nComplete.raw('textbeda94e911d3')}
        </span>
        {stuck && canRestart ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="pointer-events-auto -mr-2 h-6 px-2 text-xs"
            disabled={restart.isPending}
            onClick={restart.restart}
          >
            {restart.isPending ? tI18nComplete.raw('text75d0f1469d16') : 'Restart'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
