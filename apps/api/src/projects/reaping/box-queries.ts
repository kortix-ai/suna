/**
 * Every DB read/write the box reaper's decision loop needs, in one place.
 *
 * Split out from box-reaper.ts so the loop reads as a decision (probe → veto →
 * arm → stop) rather than as a pile of query builders, and so each query's
 * fail-safe contract — "return null when the lookup itself failed, so the caller
 * never acts on a guess" — is stated once, next to the query it belongs to.
 */

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { accounts, projectSessions, sessionSandboxes, usageEvents } from '@kortix/db';
import { db } from '../../shared/db';
import type { ProviderName } from '../../platform/providers';
import { reapBatchSize } from '../reaper-constants';
import { mergeMetadata } from './sandbox-state-sync';

export interface ReapCandidate {
  sandboxId: string;
  sessionId: string;
  accountId: string;
  provider: ProviderName;
  externalId: string;
  metadata: Record<string, unknown> | null;
  warmState: string | null;
  createdAt: Date;
}

/** Rows the sweep is allowed to examine: our own `active` rows with a box behind them. */
export function reapCandidatePredicate() {
  return and(eq(sessionSandboxes.status, 'active'), isNotNull(sessionSandboxes.externalId));
}

/**
 * One batch of candidates, least-recently-visited first.
 *
 * ROTATION, NOT STARVATION: the candidate set is capped at REAP_BATCH_SIZE so a
 * pass can't stampede the provider, but before 2026-07-29 the query had no
 * ORDER BY — Postgres returned an arbitrary (in practice heap-order, and stable
 * because the rows this pass never writes to never move) 100 of 279 matching
 * prod rows, so ~179 rows were structurally unreachable by the reaper FOREVER
 * while `tickRunningComputeCharges` kept settling their full wall-clock delta.
 * The cap was symmetric only in intent: money always accrued, reaping never
 * happened. The ORDER BY below makes the cap a rotation instead, and every row
 * the pass looks at is stamped by `markReaperVisited`, so a row cannot be
 * skipped twice in a row while another is visited twice.
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
      warmState: sql<string | null>`
        ${projectSessions.metadata}->'warm_session'->>'state'
      `,
      createdAt: sessionSandboxes.createdAt,
    })
    .from(sessionSandboxes)
    .innerJoin(
      projectSessions,
      eq(projectSessions.sessionId, sessionSandboxes.sessionId),
    )
    .where(predicate)
    // Least-recently-visited first. `reaperVisitedAt` is always written by
    // `toISOString()`, so lexicographic text order IS chronological order — no
    // cast, so a hand-edited value can never make the whole sweep throw.
    .orderBy(sql`${sessionSandboxes.metadata}->>'reaperVisitedAt' asc nulls first`)
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
      .innerJoin(projectSessions, eq(projectSessions.sessionId, sessionSandboxes.sessionId))
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
 * EVERY row the pass examined — a row it deliberately left alone (busy-vetoed,
 * warm, waiting out its TTL, provider-unknown) must still go to the back of the
 * queue, otherwise it re-wins the batch every pass and the rows behind it never
 * get looked at. That silent re-selection IS the starvation bug; one batched
 * UPDATE per pass is what makes coverage a property of the query instead of luck.
 */
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

/**
 * Which of the given account ids are ORPHANED — no longer present in
 * kortix.accounts, the app's native accounts table (basejump.accounts is
 * retired; app code no longer reads or writes it, see
 * 20260706120000000_retire_basejump.sql). An orphaned account has no
 * customer who could be mid-turn, so its boxes are exempt from the
 * lease/busy protections. Returns null on a lookup FAILURE so the caller
 * fails safe (never bypass a protection on a guess); an empty set = looked
 * up fine, none of the given ids are orphaned.
 */
export async function loadOrphanAccountIds(accountIds: string[]): Promise<Set<string> | null> {
  const distinct = [...new Set(accountIds.filter((id): id is string => !!id))];
  if (distinct.length === 0) return new Set();
  try {
    const existing = await db
      .select({ accountId: accounts.accountId })
      .from(accounts)
      .where(inArray(accounts.accountId, distinct));
    const existingIds = new Set(existing.map((r) => r.accountId));
    return new Set(distinct.filter((id) => !existingIds.has(id)));
  } catch (err) {
    console.warn(
      '[reaper] orphan-account lookup failed — failing safe (no bypass this cycle):',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Last LLM-usage timestamp per session (the indexed `usage_events.session_id`).
 * Returns `null` on a lookup FAILURE so the caller can fail safe (never stop a
 * box when we can't determine its activity). An empty map = looked up fine, no
 * usage found.
 */
export async function loadLastUsageBySession(sessionIds: string[]): Promise<Map<string, Date> | null> {
  const out = new Map<string, Date>();
  if (sessionIds.length === 0) return out;
  try {
    const rows = await db
      .select({ sessionId: usageEvents.sessionId, last: sql<string>`max(${usageEvents.createdAt})` })
      .from(usageEvents)
      .where(inArray(usageEvents.sessionId, sessionIds))
      .groupBy(usageEvents.sessionId);
    for (const r of rows) {
      if (r.sessionId && r.last) {
        const d = new Date(r.last);
        if (!Number.isNaN(d.getTime())) out.set(r.sessionId, d);
      }
    }
    return out;
  } catch (err) {
    console.warn('[reaper] usage-activity lookup failed — failing safe (no stops this cycle):', err instanceof Error ? err.message : err);
    return null;
  }
}
