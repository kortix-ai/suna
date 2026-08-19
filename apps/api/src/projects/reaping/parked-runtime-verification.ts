/**
 * Parked-runtime verification — the sweep that asks the provider whether a
 * PARKED sandbox still exists, in both directions.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until 2026-08-13 nothing ever re-verified a stopped sandbox:
 *
 *   - the box reaper's candidate predicate is `status = 'active'`
 *     (`reaping/box-queries.ts`), so it never examines a parked row;
 *   - the wake reconciler (`session-lifecycle/runtime-wake-maintenance.ts`)
 *     only looks at rows carrying a live wake fence.
 *
 * So a session that was parked and then left alone was never asked about again.
 * When Platinum lost one (incident 2026-08-12: the reconciler deleted
 * `sbx_01KZP370WDB8DGYNAQM1B875VR` while it held a completed 4.87 GB backup),
 * Kortix kept advertising it as resumable, and the truth only surfaced when a
 * human opened the session 30 hours later. Measured the same day: 16,243 parked
 * prod rows had never been re-verified and 16 were already dead.
 *
 * The sweep runs BOTH directions on purpose:
 *   - provider says `removed`  → preserve the identity now, and raise the loud
 *     `runtime.lost` error, instead of waiting for a user to trip over it;
 *   - provider says it is BACK → clear a stale `unavailable` flag. 25 sandboxes
 *     were restored by hand during the incident and every one of them had to
 *     have this flag cleared manually. The platform must do that itself, or a
 *     recovered session shows "this session's computer was lost" over a
 *     perfectly working box.
 *
 * Rotation, not a full scan: the batch is bounded and ordered by
 * least-recently-verified, the same fairness pattern `selectReapCandidates`
 * uses, so 16k rows are covered over time without ever stampeding the provider.
 */

import { sessionSandboxes } from '@kortix/db';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import { type SandboxProviderName, config } from '../../config';
import { getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import { preserveEstablishedRuntime } from '../runtime-identity';
import { runtimeWakeInProgress } from '../session-lifecycle/runtime-wake-fence';

/** How many parked rows one pass may examine. */
const PARKED_VERIFY_BATCH = 60;

export type ParkedRuntimeAction = 'preserve-lost' | 'heal-restored' | 'verified' | 'skip';

/**
 * Provider states that PROVE the sandbox object still exists and is settled.
 * Deliberately excludes every transitional state: a `restoring` box can still
 * fail, and healing on it would un-flag a session that is about to stay dead.
 */
const PRESENT_AND_SETTLED = new Set(['stopped', 'running']);

/**
 * The whole decision, as a pure function so every branch is testable without a
 * database or a provider.
 */
export function decideParkedRuntime(input: {
  providerStatus: string;
  identityState: string | null;
  wakeInProgress: boolean;
}): ParkedRuntimeAction {
  // A live wake owns this row. Two components acting on one sandbox is how a
  // wake gets cancelled underneath itself.
  if (input.wakeInProgress) return 'skip';

  const alreadyLost = input.identityState === 'unavailable';

  // `removed` is the provider's definitive "this object does not exist".
  if (input.providerStatus === 'removed') {
    return alreadyLost ? 'skip' : 'preserve-lost';
  }

  if (alreadyLost) {
    // Only a settled, present state is proof the runtime came back. `unknown`
    // (a timeout or 5xx) is not — healing on it would resurrect a dead session.
    return PRESENT_AND_SETTLED.has(input.providerStatus) ? 'heal-restored' : 'skip';
  }

  // Everything else — including `unknown` and a terminal-but-present box — is
  // simply "still there as far as we can tell". Stamp it and rotate on.
  return 'verified';
}

/** Clear the loss flags from a row whose runtime is provably back. */
function healMetadataPatch(): Record<string, unknown> {
  return { runtimeRestoredAt: new Date().toISOString() };
}

export async function verifyParkedRuntimes(now = new Date()): Promise<{
  examined: number;
  lost: number;
  healed: number;
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
        // Least-recently-verified first. Written by `toISOString()` everywhere,
        // so lexicographic text order IS chronological — no cast, so a
        // hand-edited value can never make the sweep throw.
        sql`TRUE`,
      ),
    )
    .orderBy(sql`${sessionSandboxes.metadata}->>'parkedVerifiedAt' asc nulls first`)
    .limit(PARKED_VERIFY_BATCH);

  let examined = 0;
  let lost = 0;
  let healed = 0;
  let errors = 0;

  for (const row of rows) {
    const externalId = row.externalId;
    if (!externalId) continue;
    if (!(config.ALLOWED_SANDBOX_PROVIDERS as readonly string[]).includes(row.provider)) continue;
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;

    try {
      const providerStatus = await getProvider(row.provider as SandboxProviderName)
        .getStatus(externalId)
        .catch(() => 'unknown' as const);

      const action = decideParkedRuntime({
        providerStatus,
        identityState:
          typeof metadata.runtimeIdentityState === 'string' ? metadata.runtimeIdentityState : null,
        wakeInProgress: runtimeWakeInProgress(metadata, now),
      });
      examined += 1;

      if (action === 'preserve-lost') {
        // Same classification the reaper and the wake fence write for the
        // identical observation, so the stop-reason query cannot tell the three
        // discovery paths apart. This also raises the `runtime.lost` error.
        await preserveEstablishedRuntime(row, 'parked_runtime_removed', 'provider_removed', now);
        lost += 1;
        continue;
      }

      if (action === 'heal-restored') {
        await db
          .update(sessionSandboxes)
          .set({
            metadata: sql`(
              coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
                - 'runtimeIdentityState'
                - 'runtimeUnavailableReason'
                - 'runtimeUnavailableAt'
              ) || ${JSON.stringify({ ...healMetadataPatch(), parkedVerifiedAt: now.toISOString() })}::jsonb`,
            updatedAt: now,
          })
          .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
        console.warn('[parked-verify] runtime is back — cleared unavailable flag', {
          sandboxId: row.sandboxId,
          sessionId: row.sessionId,
          externalId,
          provider: row.provider,
        });
        healed += 1;
        continue;
      }

      if (action === 'verified') {
        // Stamp only. Rotation depends on this, so it must happen even when
        // nothing interesting was found.
        await db
          .update(sessionSandboxes)
          .set({
            metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify(
              { parkedVerifiedAt: now.toISOString() },
            )}::jsonb`,
          })
          .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
      }
    } catch (error) {
      errors += 1;
      console.warn(
        `[parked-verify] failed for ${externalId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { examined, lost, healed, errors };
}
