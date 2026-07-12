import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

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

/**
 * Detach a provider-confirmed missing runtime so the same logical session can
 * provision replacement compute. This never calls provider.remove(): the
 * provider already says the object is gone. A guarded project-session update
 * prevents duplicate recovery and refuses to revive explicit deletions.
 */
export async function retireConfirmedMissingRuntime(
  row: RuntimeIdentityRow,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  if (!row.externalId) {
    throw new Error(
      `Cannot retire sandbox ${row.sandboxId} as provider-missing without an external_id`,
    );
  }
  const externalId = row.externalId;

  const retired = await db.transaction(async (tx) => {
    const [session] = await tx
      .select({
        metadata: projectSessions.metadata,
        opencodeSessionId: projectSessions.opencodeSessionId,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, row.sessionId))
      .limit(1);
    if (!session) return false;

    const sessionMetadata = {
      ...((session.metadata as Record<string, unknown> | null) ?? {}),
    };
    if (typeof sessionMetadata.deletedAt === 'string') return false;

    const previousRecoveries = Array.isArray(sessionMetadata.runtimeRecoveries)
      ? sessionMetadata.runtimeRecoveries.slice(-9)
      : [];
    const recovery = {
      externalId,
      detectedAt: now.toISOString(),
      reason,
      opencodeSessionId: session.opencodeSessionId ?? null,
    };
    const [won] = await tx
      .update(projectSessions)
      .set({
        status: 'provisioning',
        error: null,
        sandboxUrl: null,
        opencodeSessionId: null,
        metadata: {
          ...sessionMetadata,
          runtimeRecoveries: [...previousRecoveries, recovery],
          lastRuntimeRecovery: recovery,
        },
        updatedAt: now,
      })
      .where(
        and(
          eq(projectSessions.sessionId, row.sessionId),
          sql`(${projectSessions.metadata}->>'deletedAt') is null`,
          sql`exists (
            select 1 from ${sessionSandboxes} current_runtime
            where current_runtime.session_id = ${row.sessionId}
              and current_runtime.external_id = ${externalId}
          )`,
        ),
      )
      .returning({ sessionId: projectSessions.sessionId });
    if (!won) return false;

    await tx
      .delete(sessionSandboxes)
      .where(
        and(
          eq(sessionSandboxes.sandboxId, row.sandboxId),
          eq(sessionSandboxes.externalId, externalId),
        ),
      );
    return true;
  });

  if (!retired) return false;
  await endComputeSession(row.sandboxId).catch((err) =>
    console.warn(
      `[runtime-identity] failed to close compute for provider-missing ${row.sandboxId}/${externalId}:`,
      err,
    ),
  );
  console.error('[runtime-identity] retired provider-confirmed missing sandbox', {
    sessionId: row.sessionId,
    sandboxId: row.sandboxId,
    externalId,
    reason,
  });
  return true;
}
