import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { endComputeSession, reopenComputeForSandbox } from '../billing/services/compute-metering';
import type { ProviderName } from '../platform/providers';
import { db } from '../shared/db';

export const RUNTIME_IDENTITY_UNAVAILABLE = 'runtime_identity_unavailable';
export const RUNTIME_IDENTITY_ERROR =
  'The original sandbox is unavailable. Its identity was preserved and no replacement sandbox was created.';

type RuntimeIdentityRow = Pick<
  typeof sessionSandboxes.$inferSelect,
  'sandboxId' | 'sessionId' | 'externalId' | 'metadata'
>;

type RecoverableRuntimeIdentityRow = typeof sessionSandboxes.$inferSelect;

const RECOVERY_LEASE_MS = 10 * 60 * 1000;

class RuntimeIdentityCasLostError extends Error {}

function sessionIsNotDeleted() {
  return sql`coalesce(${projectSessions.metadata}->>'deletedAt', '') = ''`;
}

export type RuntimeRecoveryClaim = {
  row: RecoverableRuntimeIdentityRow & { externalId: string };
  leaseId: string;
};

/** Acquire the single-flight fence before issuing any provider recovery call. */
export async function claimInPlaceRuntimeRecovery(
  row: RecoverableRuntimeIdentityRow,
  now = new Date(),
): Promise<RuntimeRecoveryClaim | null> {
  if (!row.externalId) return null;
  const externalId = row.externalId;
  const currentMetadata = (row.metadata as Record<string, unknown> | null) ?? {};
  const currentExpiry = Number(currentMetadata.runtimeRecoveryLeaseExpiresAtMs ?? 0);
  if (Number.isFinite(currentExpiry) && currentExpiry > now.getTime()) return null;

  const leaseId = crypto.randomUUID();
  const metadata = {
    ...currentMetadata,
    runtimeIdentityState: 'recovery_claimed',
    runtimeRecoveryLeaseId: leaseId,
    runtimeRecoveryLeaseAt: now.toISOString(),
    runtimeRecoveryLeaseExpiresAtMs: now.getTime() + RECOVERY_LEASE_MS,
    preservedExternalId: externalId,
  };

  try {
    const claimed = await db.transaction(async (tx) => {
      const [liveSession] = await tx
        .update(projectSessions)
        .set({ status: 'provisioning', error: null, updatedAt: now })
        .where(and(eq(projectSessions.sessionId, row.sessionId), sessionIsNotDeleted()))
        .returning({ sessionId: projectSessions.sessionId });
      if (!liveSession) return null;

      const [claimedRow] = await tx
        .update(sessionSandboxes)
        .set({ status: 'provisioning', metadata, updatedAt: now })
        .where(
          and(
            eq(sessionSandboxes.sandboxId, row.sandboxId),
            eq(sessionSandboxes.externalId, externalId),
            sql`CASE WHEN jsonb_typeof(${sessionSandboxes.metadata}->'runtimeRecoveryLeaseExpiresAtMs') = 'number' THEN (${sessionSandboxes.metadata}->>'runtimeRecoveryLeaseExpiresAtMs')::numeric ELSE 0 END < ${now.getTime()}`,
          ),
        )
        .returning();
      if (!claimedRow) throw new RuntimeIdentityCasLostError();
      return claimedRow;
    });
    return claimed ? { row: { ...claimed, externalId }, leaseId } : null;
  } catch (err) {
    if (err instanceof RuntimeIdentityCasLostError) return null;
    throw err;
  }
}

/** Persist provider acceptance only if this request still owns the recovery fence. */
export async function markInPlaceRuntimeRecoveryAccepted(
  claim: RuntimeRecoveryClaim,
  recovery: 'running' | 'recovering',
  now = new Date(),
): Promise<RecoverableRuntimeIdentityRow | null> {
  const metadata: Record<string, unknown> = {
    ...((claim.row.metadata as Record<string, unknown> | null) ?? {}),
    runtimeIdentityState: recovery === 'running' ? 'recovered' : 'recovering',
    runtimeRecoveryStartedAt: now.toISOString(),
    preservedExternalId: claim.row.externalId,
  };
  delete metadata.runtimeUnavailableReason;
  delete metadata.runtimeUnavailableAt;
  if (recovery === 'running') {
    delete metadata.runtimeRecoveryLeaseId;
    delete metadata.runtimeRecoveryLeaseAt;
    delete metadata.runtimeRecoveryLeaseExpiresAtMs;
  }

  try {
    const updated = await db.transaction(async (tx) => {
      const [liveSession] = await tx
        .update(projectSessions)
        .set({
          status: recovery === 'running' ? 'running' : 'provisioning',
          error: null,
          updatedAt: now,
        })
        .where(and(eq(projectSessions.sessionId, claim.row.sessionId), sessionIsNotDeleted()))
        .returning({ sessionId: projectSessions.sessionId });
      if (!liveSession) return null;

      const [updatedRow] = await tx
        .update(sessionSandboxes)
        .set({
          status: recovery === 'running' ? 'active' : 'provisioning',
          metadata,
          updatedAt: now,
        })
        .where(
          and(
            eq(sessionSandboxes.sandboxId, claim.row.sandboxId),
            eq(sessionSandboxes.externalId, claim.row.externalId),
            sql`${sessionSandboxes.metadata}->>'runtimeRecoveryLeaseId' = ${claim.leaseId}`,
          ),
        )
        .returning();
      if (!updatedRow) throw new RuntimeIdentityCasLostError();
      return updatedRow;
    });
    if (updated && recovery === 'running') {
      void reopenComputeForSandbox(updated.sandboxId, updated.accountId, updated.sessionId, null, updated.provider as ProviderName).catch(
        (err) =>
          console.warn(`[runtime-identity] compute reopen failed for ${updated.sandboxId}:`, err),
      );
    }
    return updated;
  } catch (err) {
    if (err instanceof RuntimeIdentityCasLostError) return null;
    throw err;
  }
}

export async function finalizeRecoveredRuntimeIfRunning(
  row: RecoverableRuntimeIdentityRow,
): Promise<RecoverableRuntimeIdentityRow | null> {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  const leaseId =
    typeof metadata.runtimeRecoveryLeaseId === 'string' ? metadata.runtimeRecoveryLeaseId : null;
  if (!leaseId || metadata.runtimeIdentityState !== 'recovering') return row;
  if (!row.externalId) return null;
  return markInPlaceRuntimeRecoveryAccepted(
    { row: { ...row, externalId: row.externalId }, leaseId },
    'running',
  );
}

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
  const externalId = row.externalId;

  await endComputeSession(row.sandboxId).catch((err) =>
    console.warn(
      `[runtime-identity] failed to close compute for ${row.sandboxId} while preserving ${row.externalId}:`,
      err,
    ),
  );

  const metadata = {
    ...((row.metadata as Record<string, unknown> | null) ?? {}),
  };
  delete metadata.needsReprovision;
  delete metadata.runtimeRecoveryLeaseId;
  delete metadata.runtimeRecoveryLeaseAt;
  delete metadata.runtimeRecoveryLeaseExpiresAtMs;
  Object.assign(metadata, {
    runtimeIdentityState: 'unavailable',
    runtimeUnavailableReason: reason,
    runtimeUnavailableAt: now.toISOString(),
    preservedExternalId: externalId,
  });

  let preserved: typeof sessionSandboxes.$inferSelect | null = null;
  try {
    preserved = await db.transaction(async (tx) => {
      const [liveSession] = await tx
        .update(projectSessions)
        .set({
          status: 'stopped',
          error: RUNTIME_IDENTITY_ERROR,
          updatedAt: now,
        })
        .where(and(eq(projectSessions.sessionId, row.sessionId), sessionIsNotDeleted()))
        .returning({ sessionId: projectSessions.sessionId });
      if (!liveSession) return null;
      const [preservedRow] = await tx
    .update(sessionSandboxes)
    .set({ status: 'stopped', metadata, updatedAt: now })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, row.sandboxId),
            eq(sessionSandboxes.externalId, externalId),
      ),
    )
    .returning();
      if (!preservedRow) throw new RuntimeIdentityCasLostError();
      return preservedRow;
    });
  } catch (err) {
    if (!(err instanceof RuntimeIdentityCasLostError)) throw err;
  }

  if (!preserved) return null;

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
    .where(and(eq(sessionSandboxes.sandboxId, row.sandboxId), isNull(sessionSandboxes.externalId)));
  return true;
}
