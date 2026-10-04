/**
 * Auto-recovery after a provider-originated `runtime_gone`, for sessions
 * NOBODY is watching.
 *
 * `applyStoppedState` (reaping/sandbox-state-sync.ts) already gives an
 * abandoned turn's prompt back to the inbox after ANY stop — but HELD
 * (`INBOX_HOLD_MS` = 24h): "the user's next send, or 'send now' on the row,
 * releases it" (SampleCo 2026-08-25 — releasing it DUE would let the very next
 * drain tick wake the runtime the stop just shut down and bill the account for
 * it, up to three times, for a box a human might never come back to).
 *
 * That default is right when a human is looking: they will send again, or the
 * next page load's wake path (`sandbox-proxy/backend.ts` `wakeSandbox` ->
 * `runtime-restart-recovery.ts` `recoverTurnsAfterRuntimeRestart`) resumes it
 * for them. It is wrong when NOBODY is looking — a trigger run, a scheduled
 * run, or a worker/sub-agent session spawned by another session
 * (`metadata.spawned_by_session`, `sessions.ts`) — because nothing will ever
 * open that session's page to trigger the wake path, and the held prompt
 * would sit for a day and then need a human to notice and release it. Census
 * 2026-09-27 (`scratchpad/session-census.md` class B): 7 of 8 such deaths were
 * worker/trigger sessions; the pi-era factory measured 19/25 workers (76%) not
 * completing in the same window.
 *
 * This module answers exactly one question — may this ONE box recover on its
 * own right now — and, when yes, releases the SAME held prompt early instead
 * of inventing a second delivery path. Everything downstream (the wake, the
 * provider start, the turn settle, and — load-bearing — `requeueAbandonedPrompt`
 * still forcing `held: true` when the row is `isStopPausedInboxRow`, i.e. a race
 * with a genuine user Stop) is the existing, tested machinery. Nothing here can
 * make a turn resume that a user stopped: `stopPaused` in redelivery.ts is
 * checked independently of the `hold` this module asks for, and a `manual` or
 * `deadline_expired` stop never reaches this module at all (its caller gates on
 * `stopReason === 'provider_reconcile'`, which a user/idle stop never is).
 *
 * BOUND. `session_sandboxes.metadata.autoRecovery.attempts` is a rolling
 * window of past attempt timestamps, read and written under `FOR UPDATE` on the
 * sandbox row — the same idiom `settleTurnsLostToRuntimeRestart` already uses
 * for cross-replica atomicity, since deployed environments run several API
 * replicas against one database and set no per-instance scoping
 * (`instance-scope.ts`). Two replicas racing this box serialize on the row
 * lock; the loser's SELECT-after-lock sees the winner's committed attempt and
 * (correctly) treats the budget as already spent. `autoRecovery` is not in
 * `STOPPED_SANDBOX_CLEARED_KEYS`, so the window survives the very stop that
 * triggers it — a runaway stop/restart/stop loop on one box still exhausts its
 * budget instead of resetting every cycle.
 */
import { sessionSandboxes } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../../lib/db';

/** `project_sessions.origin` values nobody-is-watching by construction. */
const UNATTENDED_ORIGINS: ReadonlySet<string> = new Set(['trigger', 'schedule', 'system']);

export interface UnattendedSessionInput {
  /** `project_sessions.origin`. */
  origin: string | null;
  /** `project_sessions.metadata`. */
  metadata: Record<string, unknown> | null;
}

/**
 * Is nobody a human waiting on this session's page?
 *
 * Two independent shapes, mirroring the two the census found dying silently:
 *  - a `trigger`/`schedule`/`system` origin — a cron, webhook, or internal
 *    flow started it, matching the SAME `UNATTENDED_ORIGINS` set
 *    `on-behalf-of.ts` already uses for "no human's personal resources apply
 *    here";
 *  - `metadata.spawned_by_session` — a worker/sub-agent session another
 *    session's turn created (`sessions.ts` `callerSessionId`). Such a session
 *    is `origin: 'user'` (session-origin.ts: an in-session token always is),
 *    so the origin check alone misses it entirely — this was the majority
 *    (7 of 8) of the census's runtime_gone deaths.
 *
 * Deliberately excludes `backend` (Kortix-as-a-Backend): the end user is a
 * REMOTE system's human, which this control plane cannot observe, so it keeps
 * today's held-for-a-human default rather than guess.
 */
export function isUnattendedSession(input: UnattendedSessionInput): boolean {
  if (input.origin && UNATTENDED_ORIGINS.has(input.origin)) return true;
  const spawnedBy = input.metadata?.spawned_by_session;
  return typeof spawnedBy === 'string' && spawnedBy.length > 0;
}

/** One rolling hour, two tries, matching the task's own bound. */
export const RECOVERY_WINDOW_MS = 60 * 60 * 1000;
export const MAX_RECOVERIES_PER_WINDOW = 2;
/** Never immediately re-try the box that just died; give the provider a beat. */
export const RECOVERY_MIN_GAP_MS = 30_000;

/** Attempts still inside the rolling window, oldest first. */
export function pruneRecoveryAttempts(attempts: number[], nowMs: number): number[] {
  return attempts.filter((t) => Number.isFinite(t) && nowMs - t < RECOVERY_WINDOW_MS && nowMs - t >= 0);
}

/** Pure policy: may another attempt be spent right now? */
export function canAttemptRecovery(attempts: number[], nowMs: number): boolean {
  const recent = pruneRecoveryAttempts(attempts, nowMs);
  if (recent.length >= MAX_RECOVERIES_PER_WINDOW) return false;
  const last = recent[recent.length - 1];
  return last === undefined || nowMs - last >= RECOVERY_MIN_GAP_MS;
}

export type RecoveryClaim = 'claimed' | 'bounded';

/**
 * Atomically spend one recovery attempt for this sandbox, or report the
 * budget is spent. `FOR UPDATE` makes two concurrent callers (two API
 * replicas racing the same box-gone event) serialize: the second sees the
 * first's committed attempt and is correctly told `bounded`.
 */
export async function claimRecoveryAttempt(
  sandboxId: string,
  nowMs: number = Date.now(),
): Promise<RecoveryClaim> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ metadata: sessionSandboxes.metadata })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, sandboxId))
      .for('update')
      .limit(1);
    const existing = (row?.metadata as { autoRecovery?: { attempts?: unknown } } | null)?.autoRecovery;
    const attempts = Array.isArray(existing?.attempts)
      ? (existing!.attempts as unknown[]).filter((n): n is number => typeof n === 'number')
      : [];
    if (!canAttemptRecovery(attempts, nowMs)) return 'bounded';
    const next = [...pruneRecoveryAttempts(attempts, nowMs), nowMs];
    await tx
      .update(sessionSandboxes)
      .set({
        metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify({
          autoRecovery: { attempts: next },
        })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(sessionSandboxes.sandboxId, sandboxId));
    return 'claimed';
  });
}

export type UnattendedRecoveryOutcome =
  | 'claimed'
  /** The session has a human on it; the existing held-prompt default stands. */
  | 'skipped_attended'
  /** The bound (2/hour, 30s min gap) is already spent for this box. */
  | 'skipped_bounded'
  /** The row lock / metadata write failed; fail closed to the held default. */
  | 'error';

export interface UnattendedRecoveryDeps {
  claim: (sandboxId: string, nowMs?: number) => Promise<RecoveryClaim>;
  log?: (message: string, meta: Record<string, unknown>) => void;
}

const liveDeps: UnattendedRecoveryDeps = {
  claim: claimRecoveryAttempt,
  log: (message, meta) => console.log(message, meta),
};

/**
 * Decide, for one provider-originated `runtime_gone` stop, whether THIS
 * sandbox may recover unattended right now.
 *
 * Pure orchestration over `isUnattendedSession` + `claimRecoveryAttempt` so
 * the policy (who qualifies, how the budget is spent) is unit-testable
 * without a database, and the DB-touching claim is exercised once, in
 * integration, against a real row.
 */
export async function evaluateUnattendedRecovery(
  input: { sandboxId: string; session: UnattendedSessionInput; now?: number },
  deps: UnattendedRecoveryDeps = liveDeps,
): Promise<UnattendedRecoveryOutcome> {
  if (!isUnattendedSession(input.session)) return 'skipped_attended';
  try {
    const claim = await deps.claim(input.sandboxId, input.now);
    if (claim === 'bounded') {
      deps.log?.('[runtime-recovery] unattended recovery bounded; leaving the prompt held', {
        sandboxId: input.sandboxId,
      });
      return 'skipped_bounded';
    }
    return 'claimed';
  } catch (err) {
    deps.log?.('[runtime-recovery] recovery claim failed; leaving the prompt held', {
      sandboxId: input.sandboxId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'error';
  }
}
