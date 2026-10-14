/**
 * A retired sandbox row: `stopped`, no external id, and the id of the box it
 * gave up in its metadata. A session restore leaves one (restore-session.ts);
 * the next open claims it and boots a fresh box from the session branch.
 */

import { logger } from '../../lib/logger';
import { sessionSandboxes } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { endComputeSession } from '../../billing/services/compute-metering';
import { db } from '../../shared/db';

/** Sandbox metadata: the box this row gave up. The value is stored data: never rename it. */
export const RETIRED_EXTERNAL_ID_KEY = 'ephemeralRetiredExternalId';

export function isRetiredSandboxRow(row: {
  status: string;
  externalId: string | null;
  metadata: unknown;
}): boolean {
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  return row.status === 'stopped' && !row.externalId && typeof m[RETIRED_EXTERNAL_ID_KEY] === 'string';
}

/**
 * The wake of a retired row: drop it (it has no external id, so the identity
 * guard allows it) so the normal allocation path inserts a fresh one. Atomic:
 * of two concurrent opens exactly one wins the delete and allocates.
 */
export async function claimRetiredSandboxRow(
  sandboxId: string,
): Promise<{ nextCreateAttempt: number } | null> {
  const deleted = await db
    .delete(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        isNull(sessionSandboxes.externalId),
        eq(sessionSandboxes.status, 'stopped'),
        sql`${sessionSandboxes.metadata} ? ${RETIRED_EXTERNAL_ID_KEY}`,
      ),
    )
    .returning({ sandboxId: sessionSandboxes.sandboxId, metadata: sessionSandboxes.metadata });
  if (deleted.length === 0) return null;
  await endComputeSession(sandboxId).catch((err) =>
    logger.warn(`[retired-row] closing compute for retired ${sandboxId} failed:`, { error: err instanceof Error ? err.message : String(err) }),
  );
  // Platinum's create dedup keys on (sandbox id, template, attempt): the new
  // box is a new attempt, or its create would replay (or collide with) the
  // retired box's.
  const prev = Number((deleted[0]!.metadata as Record<string, unknown> | null)?.platinumCreateAttempt);
  return { nextCreateAttempt: (Number.isFinite(prev) && prev > 0 ? prev : 1) + 1 };
}
