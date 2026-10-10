import { sessionSandboxes } from '@kortix/db';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { type SandboxProviderName, config } from '../../config';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { isAlreadyNotRunning, isLifecycleTransitionInProgress } from '../reaping/policy';
import { applyStoppedState } from '../reaping/sandbox-state-sync';
import { claimManualSandboxStop, releaseSandboxStopClaim } from '../reaping/box-queries';
import { abortLiveTurnBeforeStop, flushDriveSyncBeforeStop, retireEphemeralOnStop } from '../reaping/stop-box';
import { holdInboxPrompts } from './inbox-rows';
import { RUNTIME_WAKE_LATE_START_GUARD_MS, runtimeWakeInProgress } from './runtime-wake-fence';

/**
 * How long the request may hold the user's Stop button before it answers
 * `stopping`. The API kills a request at 25 s (`middleware/request-deadline.ts`)
 * with a 503 that says nothing about the box. The work before the provider call
 * (daemon abort 4 s, transcript tail 3 s) and the provider stop (Platinum: GET,
 * PATCH, POST, 10 s confirm poll, one retry after 1 s) add up past that, so
 * the whole of it races this budget. Read per call so tests can shrink it.
 */
function stopSyncBudgetMs(): number {
  return Number(process.env.STOP_SYNC_BUDGET_MS) || 17_000;
}
/** The transcript tail is best-effort; it never holds a stop for more than this. */
const TRANSCRIPT_TAIL_MAX_MS = 3_000;

/** Resolve `timedOut` when `work` outlasts `ms`. `work` keeps running either way. */
async function within<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then((value) => ({ timedOut: false as const, value })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, ms));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Manual, user-triggered stop: pause the running sandbox in place (disk kept,
 * same contract as the stop-half of restart / the idle reaper's stop-idle
 * path) without provisioning anything new. Session stays resumable via
 * /start, exactly like an idle auto-stop would leave it.
 */
export async function stopSession(input: {
  projectId: string;
  sessionId: string;
  accountId: string;
  userId: string;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { projectId, sessionId, accountId, userId } = input;
  const budgetEndsAt = Date.now() + stopSyncBudgetMs();

  const [sandbox] = await db
    .select()
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sessionId, sessionId),
        eq(sessionSandboxes.projectId, projectId),
        eq(sessionSandboxes.accountId, accountId),
      ),
    )
    .limit(1);

  if (!sandbox) {
    return { status: 404, body: { error: 'Session sandbox not found' } };
  }
  const cancellingWake =
    sandbox.status === 'stopped' &&
    runtimeWakeInProgress((sandbox.metadata ?? {}) as Record<string, unknown>);
  if (sandbox.status !== 'active' && !cancellingWake) {
    return {
      status: 409,
      body: { error: 'Session is not running', status: sandbox.status },
    };
  }
  if (
    !sandbox.externalId ||
    !(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(sandbox.provider)
  ) {
    return {
      status: 400,
      body: { error: `Stop is not supported for provider ${sandbox.provider}` },
    };
  }

  const externalId = sandbox.externalId;
  const provider = getProvider(sandbox.provider as SandboxProviderName);
  const now = new Date();
  if (cancellingWake) {
    // Cancel the durable wake before the provider call. The in-flight wake task
    // then loses its finalize CAS and stops any provider start that completes
    // after this request. The cleanup guard covers a task or pod that never
    // returns from provider.start().
    await applyStoppedState({
      sandboxId: sandbox.sandboxId,
      sessionId,
      externalId: sandbox.externalId,
      stopReason: 'manual',
      metadata: {
        stoppedBy: userId,
        runtimeWakeCleanupUntilAt: new Date(
          now.getTime() + RUNTIME_WAKE_LATE_START_GUARD_MS,
        ).toISOString(),
      },
      now,
    });
  }
  // Claim the row BEFORE the abort. The abort, the transcript tail and
  // provider.stop span 3 to 7 s, and a prompt that lands in that window (a
  // second tab, a trigger, a channel message) would otherwise start a turn the
  // power-off then kills with no requeue. While the claim is live,
  // `beginSandboxTurn` refuses new prompts; `applyStoppedState` strips it.
  // `cancellingWake` rows are already `stopped`: nothing to claim.
  const claimToken = randomUUID();
  if (!cancellingWake && !(await claimManualSandboxStop(sandbox.sandboxId, claimToken, now))) {
    // Another stop (the idle reaper's, or a second click) owns the row.
    return { status: 200, body: { ok: true, session_id: sessionId, status: 'stopping' } };
  }
  // Hold the session's queued prompts before the abort, exactly as the turn's
  // own Stop does. Otherwise the abort's turn end promotes the next queued
  // prompt, and a prompt parked on an unreachable runtime re-arms on its
  // backoff: either one wakes the box the user just stopped (on the rig, a
  // parked prompt resumed and un-archived a stopped box 8 min later). The next
  // message the user sends releases the hold (`enqueueReleasingHold`).
  await holdInboxPrompts(sessionId, true).catch((err) =>
    console.warn(`[stop] holding queued prompts failed for session ${sessionId}:`, err),
  );
  // Close the live turn before powering the box off, but only when the box is
  // actually running one: `cancellingWake` means the row is already stopped
  // (a wake was mid-flight), so there is no live opencode process to abort.
  if (!cancellingWake) {
    await abortLiveTurnBeforeStop({
      sandboxId: sandbox.sandboxId,
      externalId: sandbox.externalId,
      userId,
    });
    // Drive sync: the daemon's final push, inside the request budget. Past it
    // the stop goes ahead; the daemon still pushes on SIGTERM.
    await within(
      flushDriveSyncBeforeStop({ ...sandbox, externalId: sandbox.externalId }),
      Math.max(0, budgetEndsAt - Date.now()),
    );
    // The turn-end relay can still be in flight. Persist the transcript before
    // powering off the only live reader; capture failures never prevent stop.
    //
    // A TAIL, never the whole history. This read is AWAITED — the user is
    // holding a Stop button — and a full-history read is a 60s pagination
    // with three retries in front of them. The whole copy is already
    // maintained at every turn end, which runs fire-and-forget with the box
    // definitionally up; the only gap a stop can close is the turn that just
    // ended, and one bounded page covers it.
    const { captureSessionTranscriptMirror } = await import('../lib/session-transcript-capture');
    await within(
      captureSessionTranscriptMirror(sessionId, undefined, {
        scope: 'tail',
        actorUserId: userId,
      }),
      Math.min(TRANSCRIPT_TAIL_MAX_MS, budgetEndsAt - Date.now()),
    );
  }

  const settle = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    try {
      return await settleStop();
    } catch (err) {
      if (!cancellingWake) await releaseSandboxStopClaim(sandbox.sandboxId, claimToken);
      throw err;
    }
  };
  const settleStop = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
    // An ephemeral box commits its session volume and is deleted instead of
    // stopped; its state lives on the volume.
    if (!cancellingWake) {
      const retired = await retireEphemeralOnStop({
        sandboxId: sandbox.sandboxId,
        sessionId,
        externalId,
        stopReason: 'manual',
        now,
        metadata: { stoppedBy: userId },
      });
      if (retired === 'retired') {
        return { status: 200, body: { ok: true, session_id: sessionId, status: 'stopped' } };
      }
      if (retired === 'error') {
        await releaseSandboxStopClaim(sandbox.sandboxId, claimToken);
        return { status: 502, body: { error: 'Failed to stop sandbox' } };
      }
    }
    // A transient provider failure gets ONE bounded retry (KRTX-520). The user
    // is holding a Stop button. A degraded platform edge intermittently answers
    // the stop request with a 502/503/504 (an HTML error page), and a backlog
    // can leave the box unprocessed past the 10s confirm window ("last state:
    // running") — the 2026-09-28/29 capacity incidents turned both into a 6.7%
    // 5xx burst on this route (prod, 17 of 255 requests in one hour against a
    // 0/h baseline). Stop is idempotent and the classifiers below still guard
    // every attempt, so one attempt a second later lands the stop instead of
    // returning a 502 for a stop the reaper's next pass settles anyway.
    for (let attempt = 1; ; attempt++) {
      try {
        await provider.stop(externalId);
        break;
      } catch (err) {
        if (isAlreadyNotRunning(err) || isLifecycleTransitionInProgress(err)) break;
        // The provider failure used to vanish here: the 502 body reached only
        // the client, and no log carried the cause (this is what made the
        // incident burst above diagnosable only from response durations). Name
        // every failed attempt.
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[stop] provider.stop failed for sandbox ${sandbox.sandboxId}: ${message}`);
        if (attempt > 1) {
          if (!cancellingWake) await releaseSandboxStopClaim(sandbox.sandboxId, claimToken);
          return {
            status: 502,
            body: { error: err instanceof Error ? err.message : 'Failed to stop sandbox' },
          };
        }
        await Bun.sleep(1_000);
      }
    }

    // One stop writer for the whole platform (see applyStoppedState): it settles
    // the meter against the still-active row before flipping either status, and
    // it flips both in one transaction. This path used to inline that procedure
    // and had drifted — it assigned `{...sandbox.metadata, stoppedAt, ...}`, a
    // whole-object write built from the SELECT above, so anything a concurrent
    // writer put in that column in between was silently dropped. Two live writers
    // do exactly that (projects/session-open/index.ts clears and sets the
    // `runtimeWakeId` wake fence), and the compute clamp's `lastAliveAt` stamp
    // lives one table over for the same reason. Merged, never assigned.
    if (!cancellingWake) {
      await applyStoppedState({
        sandboxId: sandbox.sandboxId,
        sessionId,
        externalId,
        stopReason: 'manual',
        metadata: { stoppedBy: userId },
        now,
      });
    }
    return { status: 200, body: { ok: true, session_id: sessionId, status: 'stopped' } };
  };

  // Answer inside the request deadline. When the provider has not confirmed in
  // time, the stop is requested, not done: the DB row stays `active` (its token
  // stays valid while the box may still run), `settle` keeps going and commits
  // the stop when the provider confirms, and the reaper's next pass stops the
  // box if this process dies first. Stop is idempotent on every path.
  const pending = settle();
  const outcome = await within(pending, budgetEndsAt - Date.now());
  if (!outcome.timedOut) return outcome.value;
  pending
    .then((r) => {
      if (r.status >= 400) console.warn(`[stop] late stop failed for sandbox ${sandbox.sandboxId}: ${r.status}`);
    })
    .catch((err) => console.warn(`[stop] late stop failed for sandbox ${sandbox.sandboxId}:`, err));
  return { status: 200, body: { ok: true, session_id: sessionId, status: 'stopping' } };
}
