import { sessionSandboxes } from '@kortix/db';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { type SandboxProviderName, config } from '../../config';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import {
  RUNTIME_WAKE_CLEANUP_LEASE_MS,
  RUNTIME_WAKE_LATE_START_GUARD_MS,
  RUNTIME_WAKE_RETRY_COOLDOWN_MS,
} from './runtime-wake-fence';

const WAKE_RECONCILE_BATCH = 100;

export async function reconcileRuntimeWakeCandidate(input: {
  claim: () => Promise<boolean>;
  getStatus: () => Promise<string>;
  stop: () => Promise<void>;
  markChecked: (status: string) => Promise<void>;
  markStopped: () => Promise<void>;
}): Promise<'stopped' | 'checked' | 'skipped'> {
  if (!(await input.claim())) return 'skipped';
  const status = await input.getStatus().catch(() => 'unknown');
  if (status === 'running') {
    await input.stop();
    await input.markStopped();
    return 'stopped';
  }
  await input.markChecked(status);
  return 'checked';
}

/**
 * Durable backstop for an ambiguous provider start. A timed-out API request can
 * still start the VM after the owning API task has failed or the pod has died.
 * Stopped rows with an expired claim or an active late-start guard are checked
 * on every maintenance pass. A late running VM is stopped before it can persist.
 */
export async function reconcileRuntimeWakeFences(now = new Date()): Promise<{
  checked: number;
  stopped: number;
  errors: number;
}> {
  const rows = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      externalId: sessionSandboxes.externalId,
      provider: sessionSandboxes.provider,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .where(
      and(
        eq(sessionSandboxes.status, 'stopped'),
        isNotNull(sessionSandboxes.externalId),
        sql`(
          (
            ${sessionSandboxes.metadata}->>'runtimeWakeId' IS NOT NULL
            AND (
              ${sessionSandboxes.metadata}->>'runtimeWakeLeaseExpiresAt' IS NULL
              OR ${sessionSandboxes.metadata}->>'runtimeWakeLeaseExpiresAt' !~ '^\\d{4}-\\d{2}-\\d{2}T'
              OR ${sessionSandboxes.metadata}->>'runtimeWakeLeaseExpiresAt' <= ${now.toISOString()}
            )
          )
          OR (
            ${sessionSandboxes.metadata}->>'runtimeWakeCleanupUntilAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
            AND ${sessionSandboxes.metadata}->>'runtimeWakeCleanupUntilAt' > ${now.toISOString()}
            AND ${sessionSandboxes.metadata}->>'runtimeWakeLateStartStoppedAt' IS NULL
          )
        )
        AND (
          ${sessionSandboxes.metadata}->>'runtimeWakeCleanupId' IS NULL
          OR ${sessionSandboxes.metadata}->>'runtimeWakeCleanupLeaseExpiresAt' IS NULL
          OR ${sessionSandboxes.metadata}->>'runtimeWakeCleanupLeaseExpiresAt' !~ '^\\d{4}-\\d{2}-\\d{2}T'
          OR ${sessionSandboxes.metadata}->>'runtimeWakeCleanupLeaseExpiresAt' <= ${now.toISOString()}
        )`,
      ),
    )
    .limit(WAKE_RECONCILE_BATCH);

  let checked = 0;
  let stopped = 0;
  let errors = 0;
  for (const row of rows) {
    const externalId = row.externalId;
    if (!externalId) continue;
    if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)) continue;
    const provider = getProvider(row.provider as SandboxProviderName);
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    const leaseExpiresAt =
      typeof metadata.runtimeWakeLeaseExpiresAt === 'string'
        ? Date.parse(metadata.runtimeWakeLeaseExpiresAt)
        : Number.NaN;
    const claimExpired =
      typeof metadata.runtimeWakeId === 'string' &&
      (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= now.getTime());
    const cleanupId = crypto.randomUUID();
    try {
      const result = await reconcileRuntimeWakeCandidate({
        claim: async () => {
          const claimedAt = new Date();
          const patch: Record<string, unknown> = {
            runtimeWakeCleanupId: cleanupId,
            runtimeWakeCleanupLeaseExpiresAt: new Date(
              claimedAt.getTime() + RUNTIME_WAKE_CLEANUP_LEASE_MS,
            ).toISOString(),
          };
          if (claimExpired) {
            Object.assign(patch, {
              runtimeWakeError: 'wake_lease_expired',
              runtimeWakeFailedAt: claimedAt.toISOString(),
              stopReason: 'runtime_wake_failed',
              stoppedAt: claimedAt.toISOString(),
              runtimeWakeRetryAfterAt: new Date(
                claimedAt.getTime() + RUNTIME_WAKE_RETRY_COOLDOWN_MS,
              ).toISOString(),
              runtimeWakeCleanupUntilAt: new Date(
                claimedAt.getTime() + RUNTIME_WAKE_LATE_START_GUARD_MS,
              ).toISOString(),
            });
          }
          const wakePredicate = claimExpired
            ? and(
                sql`${sessionSandboxes.metadata}->>'runtimeWakeId' = ${String(metadata.runtimeWakeId)}`,
                sql`(
                  ${sessionSandboxes.metadata}->>'runtimeWakeLeaseExpiresAt' IS NULL
                  OR ${sessionSandboxes.metadata}->>'runtimeWakeLeaseExpiresAt' !~ '^\\d{4}-\\d{2}-\\d{2}T'
                  OR ${sessionSandboxes.metadata}->>'runtimeWakeLeaseExpiresAt' <= ${now.toISOString()}
                )`,
              )
            : sql`${sessionSandboxes.metadata}->>'runtimeWakeId' IS NULL`;
          const [claimed] = await db
            .update(sessionSandboxes)
            .set({
              updatedAt: claimedAt,
              metadata: sql`(
                coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
                  - 'runtimeWakeId'
                  - 'runtimeWakeLeaseExpiresAt'
                  - 'runtimeWakeProviderStatus'
                ) || ${JSON.stringify(patch)}::jsonb`,
            })
            .where(
              and(
                eq(sessionSandboxes.sandboxId, row.sandboxId),
                eq(sessionSandboxes.status, 'stopped'),
                wakePredicate,
                sql`(
                  ${sessionSandboxes.metadata}->>'runtimeWakeCleanupId' IS NULL
                  OR ${sessionSandboxes.metadata}->>'runtimeWakeCleanupLeaseExpiresAt' IS NULL
                  OR ${sessionSandboxes.metadata}->>'runtimeWakeCleanupLeaseExpiresAt' !~ '^\\d{4}-\\d{2}-\\d{2}T'
                  OR ${sessionSandboxes.metadata}->>'runtimeWakeCleanupLeaseExpiresAt' <= ${now.toISOString()}
                )`,
              ),
            )
            .returning({ sandboxId: sessionSandboxes.sandboxId });
          return Boolean(claimed);
        },
        getStatus: () => provider.getStatus(externalId),
        stop: () => provider.stop(externalId),
        markChecked: async (status) => {
          await db
            .update(sessionSandboxes)
            .set({
              metadata: sql`(
                coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
                  - 'runtimeWakeCleanupId'
                  - 'runtimeWakeCleanupLeaseExpiresAt'
                ) || ${JSON.stringify({ runtimeWakeLateStartCheckedAt: new Date().toISOString(), runtimeWakeLateStartProviderStatus: status })}::jsonb`,
            })
            .where(
              and(
                eq(sessionSandboxes.sandboxId, row.sandboxId),
                eq(sessionSandboxes.status, 'stopped'),
                sql`${sessionSandboxes.metadata}->>'runtimeWakeCleanupId' = ${cleanupId}`,
              ),
            );
        },
        markStopped: async () => {
          await db
            .update(sessionSandboxes)
            .set({
              metadata: sql`(
                coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
                  - 'runtimeWakeCleanupId'
                  - 'runtimeWakeCleanupLeaseExpiresAt'
                ) || ${JSON.stringify({ runtimeWakeLateStartStoppedAt: new Date().toISOString() })}::jsonb`,
            })
            .where(
              and(
                eq(sessionSandboxes.sandboxId, row.sandboxId),
                eq(sessionSandboxes.status, 'stopped'),
                sql`${sessionSandboxes.metadata}->>'runtimeWakeCleanupId' = ${cleanupId}`,
              ),
            );
        },
      });
      if (result !== 'skipped') checked += 1;
      if (result === 'stopped') stopped += 1;
    } catch (error) {
      errors += 1;
      console.warn(
        `[runtime-wake] late-start reconciliation failed for ${row.externalId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { checked, stopped, errors };
}
