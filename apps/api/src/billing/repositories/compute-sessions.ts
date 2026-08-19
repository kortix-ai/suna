import { sandboxComputeSessions } from '@kortix/db';
import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../../shared/db';

export interface SandboxSpec {
  cpuCores: number;
  memoryGb: number;
  diskGb: number;
  gpuCount: number;
}

export async function insertComputeSession(data: typeof sandboxComputeSessions.$inferInsert) {
  const [row] = await db.insert(sandboxComputeSessions).values(data).returning();
  return row;
}

/** Return the currently open (ended_at IS NULL) row for a sandbox, if any. */
export async function getOpenComputeSession(sandboxId: string) {
  const [row] = await db
    .select()
    .from(sandboxComputeSessions)
    .where(
      and(
        eq(sandboxComputeSessions.sandboxId, sandboxId),
        isNull(sandboxComputeSessions.endedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Return the most recent metering row for a sandbox (open OR closed). Used to
 * reuse the original spec (cpu/mem/disk) when resuming a hibernated sandbox, so
 * the resumed run is billed at the same rate without re-resolving the manifest.
 */
export async function getLatestComputeSession(sandboxId: string) {
  const [row] = await db
    .select()
    .from(sandboxComputeSessions)
    .where(eq(sandboxComputeSessions.sandboxId, sandboxId))
    .orderBy(desc(sandboxComputeSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Find active sessions whose `last_billed_at` is older than `cutoff`.
 * Used by the cron tick to partially bill long-running sandboxes so a missed
 * stop hook doesn't accrue an uncharged 24h+ session.
 */
export async function findStaleActiveSessions(cutoff: Date, limit = 100) {
  return db
    .select()
    .from(sandboxComputeSessions)
    .where(
      and(
        eq(sandboxComputeSessions.state, 'active'),
        lte(sandboxComputeSessions.lastBilledAt, cutoff.toISOString()),
      ),
    )
    // Longest-unsettled first, so a saturated batch drains the most expensive
    // backlog rather than whatever the planner happened to scan.
    .orderBy(asc(sandboxComputeSessions.lastBilledAt))
    .limit(limit);
}

/**
 * Atomically CLAIM a billable window, or lose the race.
 *
 * Settling used to be a read-modify-write: read `last_billed_at` into memory,
 * debit the wallet, then `UPDATE ... WHERE id = $id`. Nothing tied the write to
 * the value that was read, so two settlers that loaded the same row both billed
 * the same seconds and both wrote the same cursor. The customer paid twice for
 * one hour, and the duplicate ledger rows were byte-identical and landed in the
 * same second — indistinguishable from two legitimate sandboxes.
 *
 * That race is not hypothetical. `projects/maintenance.ts` launches four
 * settlers inside one `Promise.all` — the reaper, the orphan sweep, the
 * stuck-session sweep, and the metering tick — and an orphaned sandbox is
 * eligible for several of them at once. Serializing the maintenance pass would
 * not fix it either: `pauseComputeSession` is also reachable from request-path
 * hooks on other replicas.
 *
 * So the cursor move IS the lock. `last_billed_at` must still equal the value
 * the caller read, and the row must still be open. A terminal claim also writes
 * `state` and `ended_at` in this statement. `cost_usd` accumulates in SQL rather
 * than from an in-memory `Number(row.costUsd) + windowCost`, which had the same
 * lost-update flaw one column over.
 *
 * Returns true when this caller owns the window and may bill it. False means
 * somebody else already did — bill nothing.
 */
export interface ClaimComputeWindowInput {
  id: string;
  /** The `last_billed_at` the caller based its window on. */
  expectedLastBilledAt: string;
  /** Where the cursor moves to when the claim succeeds. */
  nextLastBilledAt: string;
  /** Added to `cost_usd` in SQL. May be 0 for a zero-cost window. */
  addCostUsd: number;
  /** Atomically closes the row at `nextLastBilledAt` when this is a terminal settle. */
  terminalState?: 'stopped' | 'finalized';
}

/** Exported query builder so the terminal CAS predicate is tested as rendered SQL. */
export function buildClaimComputeWindowQuery(input: ClaimComputeWindowInput) {
  return db
    .update(sandboxComputeSessions)
    .set({
      lastBilledAt: input.nextLastBilledAt,
      costUsd: sql`${sandboxComputeSessions.costUsd} + ${String(input.addCostUsd)}::numeric`,
      ...(input.terminalState
        ? { state: input.terminalState, endedAt: input.nextLastBilledAt }
        : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(sandboxComputeSessions.id, input.id),
        isNull(sandboxComputeSessions.endedAt),
        eq(sandboxComputeSessions.lastBilledAt, input.expectedLastBilledAt),
      ),
    )
    .returning({ id: sandboxComputeSessions.id });
}

export async function claimComputeWindow(input: ClaimComputeWindowInput): Promise<boolean> {
  const rows = await buildClaimComputeWindowQuery(input);
  return rows.length > 0;
}

/**
 * Give a claimed window back after the debit failed.
 *
 * Preserves the deliberate "do not advance past a window we could not collect"
 * behaviour: an out-of-credits account must be able to retry the same seconds
 * once its wallet can pay, rather than silently forfeiting them.
 *
 * Also CAS'd. A partial release requires an open row. A terminal release
 * requires the exact terminal state and timestamp it wrote, then reopens the
 * row for the invariant sweep. If another settler moved the cursor, do NOT
 * force it back. That would re-open the window for double billing.
 */
export interface ReleaseComputeWindowInput {
  id: string;
  /** The cursor value this caller wrote when it claimed. */
  claimedLastBilledAt: string;
  /** Where to put the cursor back. */
  revertToLastBilledAt: string;
  subCostUsd: number;
  /** Reopens a row whose terminal claim could not be debited. */
  terminalState?: 'stopped' | 'finalized';
}

/** Exported query builder so release cannot silently reopen a closed unrelated row. */
export function buildReleaseComputeWindowQuery(input: ReleaseComputeWindowInput) {
  return db
    .update(sandboxComputeSessions)
    .set({
      lastBilledAt: input.revertToLastBilledAt,
      costUsd: sql`${sandboxComputeSessions.costUsd} - ${String(input.subCostUsd)}::numeric`,
      ...(input.terminalState ? { state: 'active' as const, endedAt: null } : {}),
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(sandboxComputeSessions.id, input.id),
        eq(sandboxComputeSessions.lastBilledAt, input.claimedLastBilledAt),
        input.terminalState
          ? and(
              eq(sandboxComputeSessions.state, input.terminalState),
              eq(sandboxComputeSessions.endedAt, input.claimedLastBilledAt),
            )
          : isNull(sandboxComputeSessions.endedAt),
      ),
    )
    .returning({ id: sandboxComputeSessions.id });
}

export async function releaseComputeWindow(input: ReleaseComputeWindowInput): Promise<boolean> {
  const rows = await buildReleaseComputeWindowQuery(input);
  return rows.length > 0;
}
