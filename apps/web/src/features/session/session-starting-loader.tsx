'use client';

import { Loader2, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { restartProjectSession, sessionStartKey, type SessionStartStage } from '@kortix/sdk/projects-client';
import { Button } from '@/components/ui/button';
import { errorToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { BootStatusLine } from './boot-status-line';

/**
 * The ONE loader shown while a session's Kortix Computer comes up — full-screen
 * for resumes, and dead-center in the side panel while a fresh session boots.
 * All the heavy lifting (provision / wake / OpenCode readiness + pin) is
 * server-side behind POST /sessions/:id/start; this just reports a calm status.
 *
 * Visual: super-minimal, perfectly centered. A single calm boot status line
 * (see {@link BootStatusLine}) and one quiet hint.
 */
const LOADER_DELAY_MS = 700;
/** After this long, swap the footer copy to set expectations for a cold start. */
const SLOW_AFTER_MS = 15_000;
/**
 * After this long, offer a manual restart. Sandboxes occasionally wedge (e.g. a
 * stuck provider-side proxy) with no server-side signal that anything is wrong —
 * a stop/start of the sandbox is the known fix, so surface it as a fallback
 * instead of leaving the user staring at "Connecting" indefinitely.
 */
const STUCK_AFTER_MS = 45_000;

/** The shared boot clock: a 1s tick used for the `slow`/`stuck` footer math. */
function useBootClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return now;
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

  // The shared boot clock owns the 1s tick that drives the `slow`/`stuck`
  // footer math below.
  const now = useBootClock();
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
          'flex flex-col items-center gap-5 transition-opacity duration-500',
          show ? 'opacity-100' : 'opacity-0',
        )}
      >
        <BootStatusLine align="center" />
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
