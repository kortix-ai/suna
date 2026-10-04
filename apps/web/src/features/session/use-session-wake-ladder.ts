'use client';

import type { QueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import {
  AUTO_RESUME_WINDOW_MS,
  isAutoResuming,
  isRuntimeIdentityUnavailable,
  isSandboxResumable,
  isWakeClassFailure,
} from '@/features/session/session-resume';
import { useRestartProjectSession } from '@/hooks/projects/use-restart-project-session';
import { sessionStartKey, wakeProgressFingerprint } from '@kortix/sdk';
import {
  type UseSessionResult,
  useRuntimeConnectionStore,
  useWakeEscalation,
} from '@kortix/sdk/react';

/**
 * The wake/auto-resume ladder for one project session route: re-issue `/start`
 * for a hibernated-but-resumable sandbox while the wake still shows progress,
 * escalate through `useWakeEscalation`'s silence-measuring budget when it does
 * not, and own the ONE restart behavior every terminal card on the route
 * shares (a manual restart re-arms auto-resume, like a fresh open would).
 *
 * Returns the pieces the route renders from: `wake` (its note/summary copy),
 * whether the ladder is still holding the terminal card off
 * (`wakeLadderHolding`), whether the box is auto-waking (`autoResuming`), and
 * the shared `restart`/`handleRestart` pair.
 */
export function useSessionWakeLadder({
  session,
  authLoading,
  hasUser,
  billingBlocked,
  projectId,
  sessionId,
  queryClient,
}: {
  session: UseSessionResult;
  authLoading: boolean;
  hasUser: boolean;
  billingBlocked: boolean;
  projectId: string;
  sessionId: string;
  queryClient: QueryClient;
}) {
  const sandbox = session.sandbox;
  const startStage = session.stage ?? 'provisioning';

  // ── Auto-resume a hibernated-but-resumable sandbox ────────────────────────
  // On the first /start of an idle-stopped session the backend can race into a
  // TERMINAL 'stopped' (openSession's self-preserve path on a transient provider
  // getStatus()) even though the row is left EXACTLY resumable (status 'stopped'
  // + external_id). useSession then stops polling and the page used to pin a
  // dead-end "open a new session" card — yet a hard refresh's fresh /start hits
  // the resume path and wakes the box. So: re-issue /start ourselves a few times
  // (what the refresh did) before ever surfacing a manual control.
  const sandboxResumable = isSandboxResumable(sandbox);
  const [resumeAttempts, setResumeAttempts] = useState(0);
  // ONE restart behavior for every card on this route: optimistic exit from the
  // terminal state, a real pending state, and a SURFACED failure.
  const restart = useRestartProjectSession(projectId, sessionId);
  // A manual restart re-arms auto-resume: the box the user just asked us to
  // reboot deserves the same wake attempts a fresh open would get.
  const handleRestart = () => {
    setResumeAttempts(0);
    restart.restart();
  };

  // ── The wake escalation ladder ────────────────────────────────────────────
  // A wake budget must measure SILENCE, not elapsed time: a wake that is
  // visibly advancing has not failed, however long it takes, and a wake that
  // has gone quiet is not saved by waiting longer. `useWakeEscalation` owns
  // that rule and the ladder that follows it — quiet `/start` retry, then the
  // RESTART the user would have clicked, bounded — so the terminal card is
  // what remains after everything has been tried, never the first response to
  // a slow provider. See `core/session/wake-escalation.ts` for the incident.
  //
  // `runtimeReachable` is the DAEMON's answer, not the session row's. Observed
  // on SampleCo 2026-08-26: `/start` answered 202 and the row stayed `running`
  // for 5+ minutes while the E2B resume had silently failed and the proxy
  // answered `503 sandbox_not_ready`. `initialCheckDone` is what makes this
  // real evidence — `useSession` optimistically seeds `healthy: true` the
  // moment `stage: 'ready'` arrives, and that seed is exactly the claim the
  // desync falsifies, so the latch must wait for a probe to have run.
  const runtimeProbed = useRuntimeConnectionStore((s) => s.initialCheckDone);
  const runtimeHealthy = useRuntimeConnectionStore((s) => s.healthy === true);
  const runtimeConnectionStatus = useRuntimeConnectionStore((s) => s.status);
  const runtimeVersion = useRuntimeConnectionStore((s) => s.openCodeVersion);
  const runtimeProbeError = useRuntimeConnectionStore((s) => s.runtimeError);
  const sandboxMetadata = (sandbox?.metadata as Record<string, unknown> | undefined) ?? {};
  const wakeStopReason =
    typeof sandboxMetadata.stopReason === 'string' ? sandboxMetadata.stopReason : null;
  // Only an ESTABLISHED runtime is woken. A session whose first sandbox is
  // still being built (`external_id` null, "Sandbox build running…") is not
  // stuck — it is doing minutes of legitimate work with no client-visible
  // signal, and restarting it would throw that build away.
  const wakeLadderApplies =
    !authLoading &&
    hasUser &&
    !billingBlocked &&
    !!sandbox?.external_id &&
    !isRuntimeIdentityUnavailable(sandbox);
  // The verdicts that used to paint a terminal card outright. There is no
  // further progress to wait for in any of them — only a rung of the ladder
  // left to try, which is precisely what the card denied the user. See
  // `isWakeClassFailure` for why `retriable` is not part of the test.
  const wakeServerGaveUp = isWakeClassFailure({
    stage: session.stage,
    reason: session.reason,
    sandbox,
  });
  const wake = useWakeEscalation({
    waking: wakeLadderApplies,
    runtimeReachable: runtimeProbed && runtimeHealthy,
    progress: wakeProgressFingerprint([
      startStage,
      session.reason,
      sandbox?.status,
      wakeStopReason,
      typeof sandboxMetadata.runtimeWakeStartedAt === 'string'
        ? sandboxMetadata.runtimeWakeStartedAt
        : null,
      session.runtimeSessionId,
      runtimeConnectionStatus,
      runtimeHealthy,
      runtimeVersion,
      runtimeProbeError,
    ]),
    serverGaveUp: wakeServerGaveUp,
    onRetryStart: () => {
      queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId, sessionId) });
    },
    // Passed straight through: `useWakeEscalation` holds the callbacks in its
    // own ref, so a rebuilt closure here cannot re-run its decision effect and
    // fire one rung twice.
    onRestart: handleRestart,
  });
  // THE progress-aware budget. Every consumer below reads time-since-CHANGE,
  // never time-since-wake-started — the fixed clock this replaces expired
  // mid-wake on a box that was seconds from ready (a SampleCo session, box
  // daemon logged `opencode ready` right after the budget ran out).
  const wakeSilentMs = wake.msSinceProgress;
  // A BOOLEAN, not the raw millisecond count, because this is an effect
  // dependency: `wakeSilentMs` advances every second, and depending on it would
  // tear down and re-arm the timer below on every tick — a backoff delay longer
  // than one second could then never elapse, silently ending the resume loop
  // after its first immediate attempt.
  const wakeShowingProgress = wakeSilentMs < AUTO_RESUME_WINDOW_MS;
  useEffect(() => {
    if (!sandboxResumable) return;
    if (!wakeShowingProgress) return;
    // First attempt fires immediately (match the refresh); back off after that,
    // and keep re-asking for as long as the wake is still showing progress.
    const t = setTimeout(
      () => {
        setResumeAttempts((n) => n + 1);
        queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId, sessionId) });
      },
      resumeAttempts === 0 ? 0 : Math.min(1500 * 2 ** Math.min(resumeAttempts - 1, 3), 8000),
    );
    return () => clearTimeout(t);
  }, [sandboxResumable, resumeAttempts, wakeShowingProgress, projectId, sessionId, queryClient]);
  // While a resumable box is still SHOWING PROGRESS it is "waking", not "dead"
  // — render the boot loader, never the dead-end card.
  const autoResuming = isAutoResuming(sandbox, { elapsedMs: wakeSilentMs });
  // The ladder still has rungs left for a wake the server has given up on. The
  // dead-end card is what happens after it runs out, not instead of it. Scoped
  // to the wake-class verdicts only: a git-auth or capacity failure is a real
  // dead end that no amount of restarting fixes, and it must still say so at
  // once.
  const wakeLadderHolding = wakeServerGaveUp && !wake.exhausted;

  return { restart, handleRestart, wake, autoResuming, wakeLadderHolding };
}
