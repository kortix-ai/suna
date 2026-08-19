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
import { and, eq, inArray, isNotNull, lte, not, sql } from 'drizzle-orm';
import type { ProviderName } from '../../platform/providers';
import { db } from '../../shared/db';
import { sandboxStopClaimLeaseMs } from '../sandbox-deadline-policy';
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
export function reapCandidatePredicate(sandboxIds?: readonly string[], activeTurnsOnly = false) {
  return and(
    eq(sessionSandboxes.status, 'active'),
    isNotNull(sessionSandboxes.externalId),
    sandboxIds
      ? sandboxIds.length > 0
        ? inArray(sessionSandboxes.sandboxId, [...sandboxIds])
        : sql`false`
      : undefined,
    activeTurnsOnly ? activeTurnAuthorityPredicate() : undefined,
  );
}

/** Durable turn authority that must receive provider-native renewal service. */
export function activeTurnAuthorityPredicate() {
  return sql`(
    (
      coalesce(${sessionSandboxes.metadata}->'activeTurn'->>'token', '') <> ''
      AND coalesce(${sessionSandboxes.metadata}->'activeTurn'->>'state', '') IN ('delivering', 'active')
    )
    OR EXISTS (
      SELECT 1
        FROM jsonb_each(CASE
          WHEN jsonb_typeof(${sessionSandboxes.metadata}->'activeTurns') = 'object'
            THEN ${sessionSandboxes.metadata}->'activeTurns'
          ELSE '{}'::jsonb
        END) entry
       WHERE entry.key = entry.value->>'token'
         AND entry.value->>'state' IN ('delivering', 'active'))
  )`;
}

/**
 * Two independent candidate lanes, each capped at REAP_BATCH_SIZE:
 *
 *   1. every row with durable turn authority, least-recently-visited first;
 *   2. the normal expired/reconciliation lane, excluding lane 1's rows.
 *
 * One shared batch cannot satisfy both safety properties. An endless backlog
 * of failed expired rows can otherwise starve active-turn renewal until E2B's
 * provider timeout stops live work. Prioritising turns in that shared batch
 * merely reverses the defect and starves idle stops. Separate rotating lanes
 * reserve capacity for both contracts on every pass.
 */
export async function selectReapCandidates(
  predicate: ReturnType<typeof reapCandidatePredicate>,
  activeTurnsOnly = false,
): Promise<ReapCandidate[]> {
  const projection = {
    sandboxId: sessionSandboxes.sandboxId,
    sessionId: sessionSandboxes.sessionId,
    accountId: sessionSandboxes.accountId,
    provider: sessionSandboxes.provider,
    externalId: sessionSandboxes.externalId,
    metadata: sessionSandboxes.metadata,
    deadlineAt: sessionSandboxes.deadlineAt,
    createdAt: sessionSandboxes.createdAt,
  };
  const visitOrder = sql`${sessionSandboxes.metadata}->>'reaperVisitedAt' asc nulls first`;
  const batchSize = reapBatchSize();

  const turnRows = (await db
    .select(projection)
    .from(sessionSandboxes)
    .where(and(predicate, activeTurnAuthorityPredicate()))
    .orderBy(
      sql`(${sessionSandboxes.deadlineAt} <= now()) desc`,
      visitOrder,
    )
    .limit(batchSize)) as ReapCandidate[];

  if (activeTurnsOnly) return turnRows;

  const regularRows = (await db
    .select(projection)
    .from(sessionSandboxes)
    .where(and(predicate, not(activeTurnAuthorityPredicate())))
    .orderBy(
      // Expired rows win this lane. Failed expiry work cannot consume the turn lane.
      sql`(${sessionSandboxes.deadlineAt} <= now()) desc`,
      // `reaperVisitedAt` is always ISO-8601. Text ordering is chronological and
      // malformed hand-edited values cannot make the whole sweep throw.
      visitOrder,
    )
    .limit(batchSize)) as ReapCandidate[];

  return [...turnRows, ...regularRows];
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
 * Linearize an idle stop against prompt delivery.
 *
 * The claim and `beginSandboxTurn` use the same metadata key. Once this update
 * commits, a new prompt fails closed before sending any byte. If a prompt wins
 * first, its turn record or deadline makes this update return no row.
 */
export async function claimExpiredSandboxStop(
  sandboxId: string,
  token: string,
  now = new Date(),
): Promise<boolean> {
  const [claimed] = await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`jsonb_set(
        CASE
          WHEN jsonb_typeof(${sessionSandboxes.metadata}) = 'object'
            THEN ${sessionSandboxes.metadata}
          ELSE '{}'::jsonb
        END,
        '{lifecycleStopClaim}',
        jsonb_build_object(
          'token', ${token}::text,
          'claimedAtMs', ${now.getTime()}::bigint),
        true)`,
      updatedAt: now,
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        eq(sessionSandboxes.status, 'active'),
        lte(sessionSandboxes.deadlineAt, now),
        sql`(
          ${sessionSandboxes.metadata}->'lifecycleStopClaim' IS NULL
          OR ${sessionSandboxes.metadata}->'lifecycleStopClaim'->>'claimedAtMs' !~ '^[0-9]+$'
          OR (${sessionSandboxes.metadata}->'lifecycleStopClaim'->>'claimedAtMs')::bigint
            <= ${now.getTime() - sandboxStopClaimLeaseMs()})`,
        sql`NOT (
          coalesce(${sessionSandboxes.metadata}->'activeTurn'->>'token', '') <> ''
          AND coalesce(${sessionSandboxes.metadata}->'activeTurn'->>'state', '') IN ('delivering', 'active'))`,
        sql`NOT EXISTS (
              SELECT 1
                FROM jsonb_each(CASE
                  WHEN jsonb_typeof(${sessionSandboxes.metadata}->'activeTurns') = 'object'
                    THEN ${sessionSandboxes.metadata}->'activeTurns'
                  ELSE '{}'::jsonb
                END) entry
               WHERE entry.key = entry.value->>'token'
                 AND entry.value->>'state' IN ('delivering', 'active'))`,
      ),
    )
    .returning({ sandboxId: sessionSandboxes.sandboxId });
  return Boolean(claimed);
}

/** Release only this failed stop attempt's claim. */
export async function releaseSandboxStopClaim(sandboxId: string, token: string): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) - 'lifecycleStopClaim'`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        sql`${sessionSandboxes.metadata}->'lifecycleStopClaim'->>'token' = ${token}`,
      ),
    );
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
