import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, isNull } from 'drizzle-orm';

import { endComputeSession } from '../billing/services/compute-metering';
import { db } from '../shared/db';

export const RUNTIME_IDENTITY_UNAVAILABLE = 'runtime_identity_unavailable';
export const RUNTIME_IDENTITY_ERROR =
  'The original sandbox is unavailable. Its identity was preserved and no replacement sandbox was created.';

type RuntimeIdentityRow = Pick<
  typeof sessionSandboxes.$inferSelect,
  'sandboxId' | 'sessionId' | 'externalId' | 'metadata'
>;

/**
 * Mark an established runtime unavailable without ever changing its identity.
 *
 * An external_id means the sandbox may contain user-authored, uncommitted data.
 * It is therefore an immutable identity boundary: provider 404s, transitional
 * states, health timeouts, and restart failures may stop the session, but may
 * never delete this row or attach a fresh provider object to the same session.
 */
export async function preserveEstablishedRuntime(
  row: RuntimeIdentityRow,
  reason: string,
  now = new Date(),
): Promise<typeof sessionSandboxes.$inferSelect | null> {
  if (!row.externalId) {
    throw new Error(
      `Cannot preserve sandbox ${row.sandboxId} as established without an external_id`,
    );
  }

  await endComputeSession(row.sandboxId).catch((err) =>
    console.warn(
      `[runtime-identity] failed to close compute for ${row.sandboxId} while preserving ${row.externalId}:`,
      err,
    ),
  );

  const metadata = { ...((row.metadata as Record<string, unknown> | null) ?? {}) };
  delete metadata.needsReprovision;
  Object.assign(metadata, {
    runtimeIdentityState: 'unavailable',
    runtimeUnavailableReason: reason,
    runtimeUnavailableAt: now.toISOString(),
    preservedExternalId: row.externalId,
  });

  const [preserved] = await db
    .update(sessionSandboxes)
    .set({ status: 'stopped', metadata, updatedAt: now })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, row.sandboxId),
        eq(sessionSandboxes.externalId, row.externalId),
      ),
    )
    .returning();

  if (!preserved) return null;

  await db
    .update(projectSessions)
    .set({ status: 'stopped', error: RUNTIME_IDENTITY_ERROR, updatedAt: now })
    .where(eq(projectSessions.sessionId, row.sessionId));

  console.error('[runtime-identity] preserved unavailable sandbox identity', {
    sessionId: row.sessionId,
    sandboxId: row.sandboxId,
    externalId: row.externalId,
    reason,
  });
  return preserved;
}

/**
 * Delete only a provisioning placeholder that never acquired provider state.
 * This guard makes accidental use against a data-bearing sandbox fail closed.
 */
export async function retireUnmaterializedRuntime(
  row: Pick<typeof sessionSandboxes.$inferSelect, 'sandboxId' | 'externalId'>,
  reason: string,
): Promise<boolean> {
  if (row.externalId) {
    throw new Error(
      `Refusing to retire established sandbox ${row.sandboxId}/${row.externalId} (${reason})`,
    );
  }

  await endComputeSession(row.sandboxId).catch((err) =>
    console.warn(
      `[runtime-identity] failed to close compute for unmaterialized sandbox ${row.sandboxId} (${reason}):`,
      err,
    ),
  );
  await db
    .delete(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.sandboxId, row.sandboxId),
        isNull(sessionSandboxes.externalId),
      ),
    );
  return true;
}
