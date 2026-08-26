import { sessionSandboxes } from '@kortix/db';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { type SandboxProviderName, config } from '../../config';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { preserveEstablishedRuntime } from '../runtime-identity';
import {
  RUNTIME_WAKE_CLEANUP_LEASE_MS,
  RUNTIME_WAKE_LATE_START_GUARD_MS,
  runtimeStartFailurePatch,
} from './runtime-wake-fence';

const WAKE_RECONCILE_BATCH = 100;

export async function reconcileRuntimeWakeCandidate(input: {
  claim: () => Promise<boolean>;
  getStatus: () => Promise<string>;
  stop: () => Promise<void>;
  markChecked: (status: string) => Promise<void>;
  markStopped: () => Promise<void>;
  /** Provider proved the parked runtime is gone — preserve its identity now. */
  markRemoved: () => Promise<void>;
}): Promise<'stopped' | 'removed' | 'checked' | 'skipped'> {
  if (!(await input.claim())) return 'skipped';
  // A throwing round-trip degrades to `unknown`, which is explicitly
  // non-terminal — a network blip must never be read as proof of removal.
  const status = await input.getStatus().catch(() => 'unknown');
  if (status === 'running') {
    await input.stop();
    await input.markStopped();
    return 'stopped';
  }
  // `removed` is the provider's DEFINITIVE answer that the box no longer
  // exists, and this pass is the only component that ever asks it about a
  // parked row (the box reaper's candidate predicate is `status = 'active'`).
  // Recording the observation and moving on left the session advertising a
  // "Restart session" button that could only ever 409, until a human opened it.
  if (status === 'removed') {
    await input.markRemoved();
    return 'removed';
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
  removed: number;
  errors: number;
}> {
  const rows = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
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
  let removed = 0;
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
              // The cooldown escalates with consecutive failures and expires on
              // its own: this stamp used to be a permanent gravestone that only
              // `POST /restart` could clear (see runtime-wake-fence.ts).
              ...runtimeStartFailurePatch(metadata, claimedAt),
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
        markRemoved: async () => {
          // Record the observation FIRST and release the cleanup lease, so the
          // forensic trail survives even if the preserve below fails — this is
          // the stamp that reconstructed the original incident.
          await db
            .update(sessionSandboxes)
            .set({
              metadata: sql`(
                coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
                  - 'runtimeWakeCleanupId'
                  - 'runtimeWakeCleanupLeaseExpiresAt'
                ) || ${JSON.stringify({
                  runtimeWakeLateStartCheckedAt: new Date().toISOString(),
                  runtimeWakeLateStartProviderStatus: 'removed',
                })}::jsonb`,
            })
            .where(
              and(
                eq(sessionSandboxes.sandboxId, row.sandboxId),
                eq(sessionSandboxes.status, 'stopped'),
                sql`${sessionSandboxes.metadata}->>'runtimeWakeCleanupId' = ${cleanupId}`,
              ),
            );
          // Re-read before preserving. `preserveEstablishedRuntime` writes the
          // WHOLE metadata object from the row it is handed, so passing the
          // pre-claim snapshot would resurrect the `runtimeWakeId` /
          // `runtimeWakeLeaseExpiresAt` keys the claim just deleted — and a
          // resurrected wake id reads as `runtimeWakeInProgress` on the next
          // open, which is the state this whole path exists to end.
          const [fresh] = await db
            .select()
            .from(sessionSandboxes)
            .where(eq(sessionSandboxes.sandboxId, row.sandboxId))
            .limit(1);
          if (!fresh?.externalId) return;
          // Same classification the box reaper writes for the identical
          // observation (reaping/box-reaper.ts `reconcile-removed`), so the
          // stop-reason query cannot tell the two discovery paths apart.
          await preserveEstablishedRuntime(fresh, 'runtime_removed', 'provider_removed');
        },
      });
      if (result !== 'skipped') checked += 1;
      if (result === 'stopped') stopped += 1;
      if (result === 'removed') removed += 1;
    } catch (error) {
      errors += 1;
      console.warn(
        `[runtime-wake] late-start reconciliation failed for ${row.externalId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { checked, stopped, removed, errors };
}
