import { and, desc, eq, isNull, lte } from 'drizzle-orm';
import { sandboxComputeSessions } from '@kortix/db';
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

export async function updateComputeSession(
  id: string,
  patch: Partial<typeof sandboxComputeSessions.$inferInsert>,
) {
  await db
    .update(sandboxComputeSessions)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(sandboxComputeSessions.id, id));
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
    .limit(limit);
}
