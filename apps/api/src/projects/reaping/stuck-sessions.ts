/**
 * Reconcile project_sessions stuck in an ACTIVE status that have no genuinely-
 * running box behind them. THE leak that wedged Slack ("I'm queued behind other
 * project work") and 429'd new sessions: a session counts against the account's
 * concurrent-session cap while its status is in ACTIVE_SESSION_STATUSES, but the
 * provider reaper (box-reaper.ts) only ever visits sessions whose
 * `session_sandboxes` row is still `active`. A session left `running` /
 * `provisioning` / `queued` / `branching` after its box was stopped or removed
 * — a missed stop webhook, a getStatus throttled to 'unknown', a continueSession
 * that flipped stopped→running then failed to deliver, or a create that never
 * got a box — is STRUCTURALLY INVISIBLE to that pass and so eats a cap slot
 * forever. Such sessions accreted to 200+ on a single account and blocked it.
 *
 * This pass closes that gap from the session side. It is DB-ONLY (no provider
 * round-trip), so it is immune to the Daytona throttling that starves the box
 * reaper, and it acts ONLY on sessions that are provably idle:
 *   - status ∈ ACTIVE_SESSION_STATUSES and untouched for longer than the auto-
 *     stop TTL (so a healthy in-flight provision/branch is never touched),
 *   - NO `active` session_sandboxes row (a live box is the provider reaper's
 *     job) — UNLESS `metadata.deletedAt` is set. A session the user deleted
 *     is tombstoned regardless of what its sandbox row says; this is the
 *     backstop for the provision-finish race (a provisioning attempt that
 *     resurrected a deleted session to 'running' before the row-level guard
 *     landed, or any other path that leaves a deleted session pointing at a
 *     live box) — it must not hide behind the active-sandbox exclusion,
 *   - NO in-flight turn (unfinalized chat_turn_stream), and
 *   - NO LLM usage within the TTL window.
 * For each it settles + closes any lingering billing window (DB-only) and flips
 * the session to `stopped` — resumable in place without changing identity.
 * Idempotent; the status guard on UPDATE avoids racing a concurrent real open.
 */

import { and, asc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { chatTurnStreams, projectSessions, sessionSandboxes, usageEvents } from '@kortix/db';
import { db } from '../../shared/db';
import { pauseComputeSession } from '../../billing/services/compute-metering';
import { ACTIVE_SESSION_STATUSES } from '../lib/session-status';
import { config } from '../../config';

const STUCK_SESSION_BATCH = 200;

/** How long a session may claim to be running with no live box behind it.
 *  Shares the idle-grace knob — the same question asked of a session rather
 *  than of a box. */
function stuckSessionCutoffMs(): number {
  return Math.max(1, config.KORTIX_SANDBOX_AUTOSTOP_MINUTES || 15) * 60_000;
}

export async function reconcileStuckActiveSessions(
  now = new Date(),
): Promise<{ candidates: number; reconciled: number; billingClosed: number; errors: number }> {
  const cutoff = new Date(now.getTime() - stuckSessionCutoffMs());

  const candidates = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(
      and(
        inArray(projectSessions.status, [...ACTIVE_SESSION_STATUSES]),
        lt(projectSessions.updatedAt, cutoff),
        or(
          sql`not exists (select 1 from ${sessionSandboxes} sb where sb.session_id = ${projectSessions.sessionId} and sb.status = 'active')`,
          sql`(${projectSessions.metadata}->>'deletedAt') is not null`,
        ),
        sql`not exists (select 1 from ${chatTurnStreams} t where t.session_id = ${projectSessions.sessionId} and t.finalized = false)`,
        sql`not exists (select 1 from ${usageEvents} u where u.session_id = ${projectSessions.sessionId} and u.created_at > ${cutoff.toISOString()})`,
      ),
    )
    // Oldest-stuck first: an unordered LIMIT is how a row stays outside every
    // batch forever while still counting against the account's session cap.
    .orderBy(asc(projectSessions.updatedAt))
    .limit(STUCK_SESSION_BATCH);

  const result = { candidates: candidates.length, reconciled: 0, billingClosed: 0, errors: 0 };
  if (candidates.length === 0) return result;

  for (const c of candidates) {
    try {
      // Close any lingering billing window for the session's (non-active) box(es).
      // pauseComputeSession is DB-only + idempotent (no-op when no row is open).
      const sbs = await db
        .select({ sandboxId: sessionSandboxes.sandboxId })
        .from(sessionSandboxes)
        .where(eq(sessionSandboxes.sessionId, c.sessionId));
      for (const sb of sbs) {
        await pauseComputeSession(sb.sandboxId).catch((err) =>
          console.warn(`[reaper] stuck-session pauseComputeSession failed for ${sb.sandboxId}:`, err instanceof Error ? err.message : err),
        );
        result.billingClosed += 1;
      }
      // Re-check the status in the UPDATE predicate so we never clobber a session
      // a real open transitioned out from under us between SELECT and UPDATE.
      const updated = await db
        .update(projectSessions)
        .set({ status: 'stopped', updatedAt: now })
        .where(and(
          eq(projectSessions.sessionId, c.sessionId),
          inArray(projectSessions.status, [...ACTIVE_SESSION_STATUSES]),
        ))
        .returning({ sessionId: projectSessions.sessionId });
      if (updated.length) result.reconciled += 1;
    } catch (err) {
      result.errors += 1;
      console.warn('[reaper] stuck-session reconcile failed:', { sessionId: c.sessionId, error: err instanceof Error ? err.message : err });
    }
  }
  return result;
}
