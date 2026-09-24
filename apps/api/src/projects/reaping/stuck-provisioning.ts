/**
 * Converge sandbox rows left in `provisioning` with a provider box behind them.
 *
 * An in-place restart and an in-place recovery move the row to `provisioning`
 * and hold a lease. Only the task that owns the lease moves the row out again.
 * When that task's process exits between `provider.start()` and its finalize
 * write, the row stays `provisioning` for good, and nothing else acts on it:
 *
 *   - the box reaper selects `active` rows only (box-queries.ts);
 *   - the orphan-box reaper keeps every `provisioning` row;
 *   - the parked-runtime sweep selects `stopped` rows only;
 *   - Stop answers 409 for any row that is not `active`.
 *
 * The box then runs with no Kortix deadline until the provider's own idle timer
 * stops it (up to 12 hours on Daytona and Platinum).
 *
 * This lane picks up a `provisioning` row once its restart or recovery lease has
 * expired, or once it has not changed for `STUCK_WITHOUT_LEASE_MS` when it holds
 * no lease, asks the provider, and converges the row to what the provider says.
 */

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm';

import { type SandboxProviderName, config } from '../../config';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { finalizeRecoveredRuntimeIfRunning, preserveEstablishedRuntime } from '../runtime-identity';
import { runtimeWakeInProgress } from '../session-lifecycle/runtime-wake-fence';
import { stripMetadataKeys } from '../session-lifecycle/sandbox-metadata-sql';
import {
  DELETED_SESSION_CLEARED_KEYS,
  PROVIDER_REMOVAL_PENDING_KEY,
  attemptArchivedBoxRemoval,
} from './archived-box-removal';
import { applyStoppedState } from './sandbox-state-sync';

/** A row with no lease that has not changed for this long has no live owner. */
export const STUCK_WITHOUT_LEASE_MS = 30 * 60_000;
const BATCH = 40;

const LEASE_KEYS = [
  'runtimeRestartId',
  'runtimeRestartStartedAt',
  'runtimeRestartLeaseExpiresAt',
  'runtimeRestartPhase',
  'runtimeRecoveryLeaseId',
  'runtimeRecoveryLeaseAt',
  'runtimeRecoveryLeaseExpiresAtMs',
] as const;

export type StuckProvisioningAction =
  | 'activate'
  | 'park'
  | 'preserve-lost'
  | 'archive-remove'
  | 'skip';

/** True when no live owner can still finish this row. */
export function provisioningOwnerLapsed(
  metadata: Record<string, unknown>,
  updatedAt: Date,
  now: Date,
): boolean {
  const restartExpiry = Date.parse(String(metadata.runtimeRestartLeaseExpiresAt ?? ''));
  const recoveryExpiry = Number(metadata.runtimeRecoveryLeaseExpiresAtMs);
  const hasRestartLease = typeof metadata.runtimeRestartId === 'string';
  const hasRecoveryLease = typeof metadata.runtimeRecoveryLeaseId === 'string';
  if (hasRestartLease && Number.isFinite(restartExpiry) && restartExpiry > now.getTime()) {
    return false;
  }
  if (hasRecoveryLease && Number.isFinite(recoveryExpiry) && recoveryExpiry > now.getTime()) {
    return false;
  }
  if (hasRestartLease || hasRecoveryLease) return true;
  return now.getTime() - updatedAt.getTime() >= STUCK_WITHOUT_LEASE_MS;
}

/** The whole decision, pure. */
export function decideStuckProvisioning(input: {
  providerStatus: string;
  sessionDeleted: boolean;
  wakeInProgress: boolean;
  ownerLapsed: boolean;
}): StuckProvisioningAction {
  if (!input.ownerLapsed || input.wakeInProgress) return 'skip';
  if (input.sessionDeleted) return 'archive-remove';
  if (input.providerStatus === 'running') return 'activate';
  if (input.providerStatus === 'stopped') return 'park';
  if (input.providerStatus === 'removed') return 'preserve-lost';
  // `unknown` and transitional states prove nothing; ask again next pass.
  return 'skip';
}

/** The lease identity a converge write CASes on: unchanged since it was read. */
function sameLease(metadata: Record<string, unknown>) {
  const restartId = typeof metadata.runtimeRestartId === 'string' ? metadata.runtimeRestartId : '';
  const recoveryId =
    typeof metadata.runtimeRecoveryLeaseId === 'string' ? metadata.runtimeRecoveryLeaseId : '';
  return and(
    eq(sessionSandboxes.status, 'provisioning'),
    sql`coalesce(${sessionSandboxes.metadata}->>'runtimeRestartId', '') = ${restartId}`,
    sql`coalesce(${sessionSandboxes.metadata}->>'runtimeRecoveryLeaseId', '') = ${recoveryId}`,
  );
}

export async function convergeStuckProvisioningRuntimes(now = new Date()): Promise<{
  examined: number;
  activated: number;
  parked: number;
  lost: number;
  archived: number;
  errors: number;
}> {
  const out = { examined: 0, activated: 0, parked: 0, lost: 0, archived: 0, errors: 0 };
  const rows = await db
    .select({
      row: sessionSandboxes,
      sessionMetadata: projectSessions.metadata,
    })
    .from(sessionSandboxes)
    .leftJoin(projectSessions, eq(projectSessions.sessionId, sessionSandboxes.sessionId))
    .where(
      and(
        eq(sessionSandboxes.status, 'provisioning'),
        isNotNull(sessionSandboxes.externalId),
        // Cheap pre-filter; the exact lease test runs per row below.
        lte(sessionSandboxes.updatedAt, new Date(now.getTime() - 60_000)),
      ),
    )
    .orderBy(sessionSandboxes.updatedAt)
    .limit(BATCH);

  for (const { row, sessionMetadata } of rows) {
    const externalId = row.externalId;
    if (!externalId) continue;
    if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)) continue;
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const ownerLapsed = provisioningOwnerLapsed(metadata, row.updatedAt, now);
    if (!ownerLapsed) continue;
    try {
      const provider = getProvider(row.provider as SandboxProviderName);
      const providerStatus = await provider.getStatus(externalId).catch(() => 'unknown' as const);
      const sessionDeleted =
        typeof (sessionMetadata as Record<string, unknown> | null)?.deletedAt === 'string';
      const action = decideStuckProvisioning({
        providerStatus,
        sessionDeleted,
        wakeInProgress: runtimeWakeInProgress(metadata, now),
        ownerLapsed,
      });
      if (action === 'skip') continue;
      out.examined += 1;

      if (action === 'archive-remove') {
        const patch = {
          stoppedAt: now.toISOString(),
          stopReason: 'manual',
          [PROVIDER_REMOVAL_PENDING_KEY]: now.toISOString(),
        };
        const [archived] = await db
          .update(sessionSandboxes)
          .set({
            status: 'archived',
            metadata: sql`(${stripMetadataKeys([...DELETED_SESSION_CLEARED_KEYS, ...LEASE_KEYS])}) || ${JSON.stringify(patch)}::jsonb`,
            updatedAt: now,
          })
          .where(and(eq(sessionSandboxes.sandboxId, row.sandboxId), sameLease(metadata)))
          .returning({ sandboxId: sessionSandboxes.sandboxId });
        if (archived) {
          await attemptArchivedBoxRemoval({ ...row, externalId, metadata: patch }, now);
          out.archived += 1;
        }
        continue;
      }

      if (action === 'preserve-lost') {
        await preserveEstablishedRuntime(row, 'provisioning_runtime_removed', 'provider_removed', now);
        out.lost += 1;
        continue;
      }

      if (action === 'activate') {
        if (metadata.runtimeIdentityState === 'recovering') {
          if (await finalizeRecoveredRuntimeIfRunning(row)) out.activated += 1;
          continue;
        }
        const patch: Record<string, unknown> = { provisioningConvergedAt: now.toISOString() };
        if (metadata.runtimeIdentityState === 'recovery_claimed') {
          patch.runtimeIdentityState = 'recovered';
        }
        const [activated] = await db
          .update(sessionSandboxes)
          .set({
            status: 'active',
            metadata: sql`(${stripMetadataKeys(LEASE_KEYS)}) || ${JSON.stringify(patch)}::jsonb`,
            updatedAt: now,
          })
          .where(and(eq(sessionSandboxes.sandboxId, row.sandboxId), sameLease(metadata)))
          .returning({ sandboxId: sessionSandboxes.sandboxId });
        if (!activated) continue;
        await db
          .update(projectSessions)
          .set({ status: 'running', updatedAt: now })
          .where(
            and(
              eq(projectSessions.sessionId, row.sessionId),
              sql`coalesce(${projectSessions.metadata}->>'deletedAt', '') = ''`,
            ),
          );
        out.activated += 1;
        continue;
      }

      // park: the provider says the box is stopped. Take the row with a CAS
      // first, so a restart claimed since the read is never parked under it.
      const [claimed] = await db
        .update(sessionSandboxes)
        .set({
          metadata: sql`(${stripMetadataKeys(LEASE_KEYS)}) || ${JSON.stringify({ provisioningConvergedAt: now.toISOString() })}::jsonb`,
          updatedAt: now,
        })
        .where(and(eq(sessionSandboxes.sandboxId, row.sandboxId), sameLease(metadata)))
        .returning({ sandboxId: sessionSandboxes.sandboxId });
      if (!claimed) continue;
      await applyStoppedState({
        sandboxId: row.sandboxId,
        sessionId: row.sessionId,
        externalId,
        stopReason: 'provisioning_stalled',
        now,
      });
      out.parked += 1;
    } catch (error) {
      out.errors += 1;
      console.warn(
        `[stuck-provisioning] converge failed for ${externalId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return out;
}
