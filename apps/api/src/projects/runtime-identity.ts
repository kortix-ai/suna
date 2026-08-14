import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { endComputeSession, reopenComputeForSandbox } from '../billing/services/compute-metering';
import { logger } from '../lib/logger';
import { captureException } from '../lib/sentry';
import { getProvider, type ProviderName } from '../platform/providers';
import { db } from '../shared/db';
import type { StopReason } from './stop-reason';

export const RUNTIME_IDENTITY_UNAVAILABLE = 'runtime_identity_unavailable';
/** Stable alert key. Better Stack / Sentry rules match on this, not on prose. */
export const RUNTIME_LOST_EVENT = 'runtime.lost';
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
 *
 * `stopReason` is REQUIRED and has no default ON PURPOSE. This function serves
 * several unrelated populations — provider removals, failed wakes, failed
 * restarts, stalled provisioning — and it cannot tell them apart from the
 * inside. It used to hard-code `provider_removed`, which reported every
 * 90-second failed wake as "the provider said the box was gone", i.e. confident
 * wrong data in the one query this field exists to answer. A required parameter
 * makes a new call site a compile error instead of a silent misclassification;
 * `reason` stays free text for humans reading a row, `stopReason` is the closed
 * value the classification query groups on.
 */
export async function preserveEstablishedRuntime(
  row: RuntimeIdentityRow,
  reason: string,
  stopReason: StopReason,
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
    // NOT resumable in place — /start must branch on runtimeIdentityState, not
    // on the bare `stopped` status (see Task 7). WHICH park this is comes from
    // the caller; see the note on the parameter above.
    stopReason,
    stoppedAt: now.toISOString(),
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

  reportLostRuntime(preserved, reason, stopReason, now);
  return preserved;
}

/**
 * The gate between "the computer failed" and "the computer was LOST".
 *
 * Only a fresh, definitive provider `removed` may classify an identity as
 * lost. Every other answer — a present state, a transitional state, or a probe
 * the provider could not answer — parks the runtime as an ordinary stopped row
 * that a later `/start` can wake. Incident 2026-08-14: a dead local tunnel kept
 * two healthy sandboxes from booting, the on-open path preserved both as lost
 * without asking the provider, and both control planes showed the boxes running
 * the whole time (docs/incidents/2026-08-14-computer-lost-false-alarm-and-boot-failures.md).
 */
export type RuntimeLossVerdict = 'preserve' | 'park';

export function runtimeLossVerdict(providerStatus: string): RuntimeLossVerdict {
  return providerStatus === 'removed' ? 'preserve' : 'park';
}

/**
 * Metadata patch for a parked (NOT lost) runtime. Pure so a test can pin that
 * a park never carries `runtimeIdentityState: 'unavailable'` — the one flag the
 * web renders as "This session's computer was lost".
 */
export function parkMetadataPatch(
  reason: string,
  stopReason: StopReason,
  now: Date,
): Record<string, unknown> {
  return {
    stopReason,
    stoppedAt: now.toISOString(),
    runtimeParkReason: reason,
  };
}

type ParkableRuntimeRow = Pick<
  typeof sessionSandboxes.$inferSelect,
  'sandboxId' | 'sessionId' | 'externalId' | 'metadata' | 'provider'
>;

/**
 * Park an established runtime that FAILED without being lost: close its
 * compute window, stop the provider box, and record an ordinary stopped row.
 * Unlike {@link preserveEstablishedRuntime} it writes no loss flags, so the
 * session stays wakeable and the UI shows the honest "restart it" card. The
 * provider stop is load-bearing, not defensive: the incident's boot-failed
 * boxes stayed RUNNING on both providers after their rows were marked stopped
 * and their metering closed — unmetered compute until a backstop fired.
 */
export async function parkEstablishedRuntime(
  row: ParkableRuntimeRow,
  reason: string,
  stopReason: StopReason,
  now = new Date(),
): Promise<typeof sessionSandboxes.$inferSelect | null> {
  if (!row.externalId) {
    throw new Error(`Cannot park sandbox ${row.sandboxId} as established without an external_id`);
  }
  const externalId = row.externalId;

  await endComputeSession(row.sandboxId).catch((err) =>
    console.warn(
      `[runtime-identity] failed to close compute for ${row.sandboxId} while parking ${externalId}:`,
      err,
    ),
  );
  await getProvider(row.provider as ProviderName)
    .stop(externalId)
    .catch((err) =>
      console.warn(
        `[runtime-identity] provider stop failed while parking ${externalId}:`,
        err instanceof Error ? err.message : err,
      ),
    );

  const metadata = {
    ...((row.metadata as Record<string, unknown> | null) ?? {}),
  };
  delete metadata.needsReprovision;
  delete metadata.runtimeRecoveryLeaseId;
  delete metadata.runtimeRecoveryLeaseAt;
  delete metadata.runtimeRecoveryLeaseExpiresAtMs;
  Object.assign(metadata, parkMetadataPatch(reason, stopReason, now));

  try {
    return await db.transaction(async (tx) => {
      const [liveSession] = await tx
        .update(projectSessions)
        .set({ status: 'stopped', error: null, updatedAt: now })
        .where(and(eq(projectSessions.sessionId, row.sessionId), sessionIsNotDeleted()))
        .returning({ sessionId: projectSessions.sessionId });
      if (!liveSession) return null;
      const [parkedRow] = await tx
        .update(sessionSandboxes)
        .set({ status: 'stopped', metadata, updatedAt: now })
        .where(
          and(
            eq(sessionSandboxes.sandboxId, row.sandboxId),
            eq(sessionSandboxes.externalId, externalId),
          ),
        )
        .returning();
      if (!parkedRow) throw new RuntimeIdentityCasLostError();
      return parkedRow;
    });
  } catch (err) {
    if (err instanceof RuntimeIdentityCasLostError) return null;
    throw err;
  }
}

/**
 * A session's computer disappeared. THIS MUST NEVER HAPPEN, so it is reported
 * as a hard error rather than a log line — losing one is losing a user's
 * uncommitted work, and it is unrecoverable by definition.
 *
 * Two sinks on purpose:
 *   - `logger.error` with a STABLE `event` name, so Better Stack can alert on
 *     `event:"runtime.lost"` instead of grepping a free-text message.
 *   - `captureException`, so it lands in the error tracker as an exception with
 *     a stack, not somewhere in a log firehose nobody reads.
 *
 * The payload carries what an investigation actually needs on the PROVIDER
 * side: which provider and which of its ids, who lost work, and how long the
 * box had been parked before it vanished. `parkedForMs` is the field that
 * separates "died in service" from "died while parked", which are different
 * bugs with different owners.
 */
function reportLostRuntime(
  row: typeof sessionSandboxes.$inferSelect,
  reason: string,
  stopReason: StopReason,
  now: Date,
): void {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  const parkedAtRaw = metadata.stretchParkedAt ?? metadata.stoppedAt;
  const parkedAtMs = typeof parkedAtRaw === 'string' ? Date.parse(parkedAtRaw) : Number.NaN;
  const detail = {
    event: RUNTIME_LOST_EVENT,
    provider: row.provider,
    externalId: row.externalId,
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    projectId: row.projectId,
    accountId: row.accountId,
    reason,
    stopReason,
    // Which code path proved it, so a spike can be attributed to a discovery
    // change rather than to a real change in provider loss.
    discoveredBy: reason,
    parkedForMs: Number.isFinite(parkedAtMs) ? now.getTime() - parkedAtMs : null,
    sandboxCreatedAt: row.createdAt?.toISOString() ?? null,
    template: typeof metadata.template === 'string' ? metadata.template : null,
  };

  logger.error('Session runtime lost by the provider — user work is unrecoverable', detail);
  captureException(
    new Error(`runtime_lost: ${row.provider}/${row.externalId} (${reason})`),
    detail,
  );
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
