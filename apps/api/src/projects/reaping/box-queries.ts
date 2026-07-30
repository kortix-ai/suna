/**
 * Every DB read/write the box reaper's decision loop needs, in one place.
 *
 * Split out from box-reaper.ts so the loop reads as a decision (deadline
 * expired → stop) rather than as a pile of query builders.
 *
 * This file used to also load `usage_events` (a fallback activity clock),
 * `accounts` (the orphan-account bypass) and `project_sessions` (the warm-pool
 * exemption) on every pass. All three existed to reconstruct "is this box still
 * wanted?" from side evidence, because the direct answer lived nowhere. It now
 * lives in `session_sandboxes.deadline_at`, so the candidate query is a single
 * table again.
 */

import { sessionSandboxes } from '@kortix/db';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { ProviderName } from '../../platform/providers';
import { db } from '../../shared/db';
import { reapBatchSize } from '../reaper-constants';
import { mergeMetadata } from './sandbox-state-sync';

export interface ReapCandidate {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  provider: ProviderName;
  externalId: string;
  metadata: Record<string, unknown> | null;
  deadlineAt: Date;
  createdAt: Date;
}

/** Rows the sweep is allowed to examine: our own `active` rows with a box behind them. */
export function reapCandidatePredicate() {
  return and(eq(sessionSandboxes.status, 'active'), isNotNull(sessionSandboxes.externalId));
}

/**
 * One batch of candidates: EXPIRED first, then least-recently-visited.
 *
 * ROTATION, NOT STARVATION: the candidate set is capped at REAP_BATCH_SIZE so a
 * pass can't stampede the provider, but before 2026-07-29 the query had no
 * ORDER BY — Postgres returned an arbitrary 100 of 279 matching prod rows, so
 * ~179 rows were structurally unreachable by the reaper FOREVER while
 * `tickRunningComputeCharges` kept settling their full wall-clock delta. The
 * rotation key below makes the cap FAIR; the leading `deadline_at <= now()`
 * key makes it also CORRECT, because a batch saturated with healthy rows can no
 * longer defer the one row that is actually over its deadline.
 */
export async function selectReapCandidates(
  predicate: ReturnType<typeof reapCandidatePredicate>,
): Promise<ReapCandidate[]> {
  return (await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId,
      provider: sessionSandboxes.provider,
      externalId: sessionSandboxes.externalId,
      metadata: sessionSandboxes.metadata,
      deadlineAt: sessionSandboxes.deadlineAt,
      createdAt: sessionSandboxes.createdAt,
    })
    .from(sessionSandboxes)
    .where(predicate)
    .orderBy(
      // Expired rows always win the batch — the whole point of the sweep.
      sql`(${sessionSandboxes.deadlineAt} <= now()) desc`,
      // Then least-recently-visited, so the RECONCILE half of the sweep (asking
      // the provider its real state for every active row) still rotates rather
      // than starving. `reaperVisitedAt` is always written by `toISOString()`,
      // so lexicographic text order IS chronological order — no cast, so a
      // hand-edited value can never make the whole sweep throw.
      sql`${sessionSandboxes.metadata}->>'reaperVisitedAt' asc nulls first`,
    )
    .limit(reapBatchSize())) as ReapCandidate[];
}

/**
 * Total rows matching the candidate predicate, so a saturated batch is visible
 * (`deferred`) instead of silent. Degrades to the batch size on failure —
 * observability must never be able to break the sweep itself.
 */
export async function countReapCandidates(
  predicate: ReturnType<typeof reapCandidatePredicate>,
  fallback: number,
): Promise<number> {
  try {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(sessionSandboxes)
      .where(predicate);
    const total = Number(row?.total);
    return Number.isFinite(total) ? total : fallback;
  } catch (err) {
    console.warn('[reaper] candidate count failed:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

/**
 * Stamp the rotation cursor for a whole batch in one statement. Stamped for
 * EVERY row the pass examined — a row it deliberately left alone (deadline not
 * yet reached, provider-unknown) must still go to the back of the queue,
 * otherwise it re-wins the batch every pass and the rows behind it never get
 * looked at. That silent re-selection IS the starvation bug; one batched UPDATE
 * per pass is what makes coverage a property of the query instead of luck.
 */
/**
 * Re-read ONE row's deadline, for the check immediately before a provider stop.
 *
 * THE TOCTOU THIS CLOSES: the sweep reads its candidates, then spends a
 * multi-second provider round-trip per row asking `getStatus`, and only then
 * decides. A prompt that arrives inside that window extends `deadline_at` — and
 * the pass, still holding a snapshot from before the round-trip, stopped the box
 * anyway. The user's turn died on a box the control plane had already agreed to
 * keep. One extra indexed read per row that is ABOUT TO BE STOPPED (never on the
 * healthy path) is the whole cost.
 *
 * Returns null when the read FAILED or the row is gone — the caller then does
 * NOT stop (never act on uncertainty; the next pass retries in minutes).
 */
export async function reloadDeadlineAt(sandboxId: string): Promise<Date | null> {
  try {
    const [row] = await db
      .select({ deadlineAt: sessionSandboxes.deadlineAt })
      .from(sessionSandboxes)
      .where(eq(sessionSandboxes.sandboxId, sandboxId))
      .limit(1);
    return row?.deadlineAt ?? null;
  } catch (err) {
    console.warn(
      `[reaper] deadline re-read failed for ${sandboxId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export async function markReaperVisited(sandboxIds: string[], now: Date): Promise<void> {
  if (sandboxIds.length === 0) return;
  await db
    .update(sessionSandboxes)
    .set({ metadata: mergeMetadata({ reaperVisitedAt: now.toISOString() }) })
    .where(inArray(sessionSandboxes.sandboxId, sandboxIds))
    .catch((err) =>
      console.warn('[reaper] visit stamp failed:', err instanceof Error ? err.message : err),
    );
}
