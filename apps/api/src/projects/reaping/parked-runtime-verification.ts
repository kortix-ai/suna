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
 * When Platinum lost one (incident 2026-08-12: the reconciler deleted a
 * parked sandbox while it held a completed 4.87 GB backup),
 * Kortix kept advertising it as resumable, and the truth only surfaced when a
 * human opened the session 30 hours later. Measured the same day: 16,243 parked
 * prod rows had never been re-verified and 16 were already dead.
 *
 * The sweep runs BOTH directions on purpose:
 *   - provider says `removed`  → ask the in-place recovery gate first, exactly
 *     as the `/start` open path does. A recoverable box is restarted; only a
 *     provider `unavailable` preserves the identity and raises the loud
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

import { endComputeSession } from '../../billing/services/compute-metering';
import { type SandboxProviderName, config } from '../../config';
import { type InPlaceRecoveryStatus, getProvider } from '../../platform/providers';
import { db } from '../../shared/db';
import {
  claimInPlaceRuntimeRecovery,
  markInPlaceRuntimeRecoveryAccepted,
  preserveEstablishedRuntime,
} from '../runtime-identity';
import { runtimeWakeInProgress } from '../session-lifecycle/runtime-wake-fence';

/** How many parked rows one pass may examine. */
const PARKED_VERIFY_BATCH = 60;

export type ParkedRuntimeAction =
  | 'attempt-recovery'
  | 'heal-restored'
  | 'stop-pending'
  | 'settle-stop-pending'
  | 'verified'
  | 'skip';

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
  stopPending: boolean;
}): ParkedRuntimeAction {
  // A live wake owns this row. Two components acting on one sandbox is how a
  // wake gets cancelled underneath itself.
  if (input.wakeInProgress) return 'skip';

  const alreadyLost = input.identityState === 'unavailable';

  // `removed` is the provider's definitive "this object does not exist". It is
  // NOT proof the data is gone: the same answer covers a `failed-start` box
  // that booted before and a tombstoned box with a completed backup, and
  // `recoverInPlace` is the one gate that tells those from a real loss. The
  // `/start` open path already asks it before declaring a runtime lost; the
  // sweep must too, or it condemns a restorable parked box before anyone opens
  // it (the `parked_runtime_removed` pattern).
  if (input.providerStatus === 'removed') {
    return alreadyLost ? 'skip' : 'attempt-recovery';
  }

  if (alreadyLost) {
    // Only a settled, present state is proof the runtime came back. `unknown`
    // (a timeout or 5xx) is not — healing on it would resurrect a dead session.
    return PRESENT_AND_SETTLED.has(input.providerStatus) ? 'heal-restored' : 'skip';
  }

  if (input.stopPending) {
    if (input.providerStatus === 'running') return 'stop-pending';
    if (input.providerStatus === 'stopped') return 'settle-stop-pending';
    return 'skip';
  }

  // Everything else — including `unknown` and a terminal-but-present box — is
  // simply "still there as far as we can tell". Stamp it and rotate on.
  return 'verified';
}

/** The outcome of asking the provider to recover a runtime the sweep saw removed. */
export type ParkedRemovalOutcome = 'recovered' | 'preserve-lost' | 'recovery-in-flight';

/**
 * Resolve one `removed` parked row against the provider's in-place recovery
 * gate, as injected dependencies so the decision is testable without a database
 * or a provider.
 *
 * A provider without `recoverInPlace` cannot be asked, so the answer stays the
 * historical one: preserve the identity. When another caller already owns a
 * recovery for the row (`claim` false), the sweep leaves it alone rather than
 * racing a restore that is in progress. Only an explicit `unavailable` from the
 * provider authorizes the loss.
 */
export async function decideRemovedParkedOutcome(input: {
  externalId: string;
  recoverInPlace?: (externalId: string) => Promise<InPlaceRecoveryStatus>;
  claim: () => Promise<boolean>;
  markRecovered: (recovery: 'running' | 'recovering') => Promise<boolean>;
}): Promise<ParkedRemovalOutcome> {
  if (!input.recoverInPlace) return 'preserve-lost';
  const claimed = await input.claim();
  if (!claimed) return 'recovery-in-flight';
  const recovery = await input.recoverInPlace(input.externalId).catch(() => 'unavailable' as const);
  if (recovery === 'running' || recovery === 'recovering') {
    // The mark is the write that ends the recovery. If another writer beat us to
    // the row the provider still recovered, but this sweep no longer owns the
    // transition — fall through and re-observe on the next pass.
    return (await input.markRecovered(recovery)) ? 'recovered' : 'recovery-in-flight';
  }
  return 'preserve-lost';
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
    .select()
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
        stopPending: typeof metadata.providerStopPendingAt === 'string',
      });
      examined += 1;

      if (action === 'attempt-recovery') {
        // A `removed` status is ambiguous: recoverable (failed-start / backup)
        // or gone. Ask the same in-place recovery gate the `/start` open path
        // uses before the sweep writes a permanent loss.
        const provider = getProvider(row.provider as SandboxProviderName);
        let claim: Awaited<ReturnType<typeof claimInPlaceRuntimeRecovery>> = null;
        let lossRow = row;

        const outcome = await decideRemovedParkedOutcome({
          externalId,
          recoverInPlace: provider.recoverInPlace?.bind(provider),
          claim: async () => {
            claim = await claimInPlaceRuntimeRecovery(row, now);
            if (claim) lossRow = claim.row;
            return claim !== null;
          },
          markRecovered: async (recovery) => {
            if (!claim) return false;
            const recovered = await markInPlaceRuntimeRecoveryAccepted(claim, recovery, now);
            if (recovered) healed += 1;
            return recovered !== null;
          },
        });

        if (outcome === 'recovered' || outcome === 'recovery-in-flight') continue;

        // Provider answered `unavailable` (or cannot be asked): a real removal.
        // Same classification the reaper and the wake fence write for the
        // identical observation, so the stop-reason query cannot tell the three
        // discovery paths apart. This also raises the `runtime.lost` error.
        await preserveEstablishedRuntime(
          lossRow,
          'parked_runtime_removed',
          'provider_removed',
          now,
        );
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

      if (action === 'stop-pending' || action === 'settle-stop-pending') {
        const stopPendingAt = metadata.providerStopPendingAt as string;
        await db.transaction(async (tx) => {
          const [owned] = await tx
            .select({ sandboxId: sessionSandboxes.sandboxId })
            .from(sessionSandboxes)
            .where(
              and(
                eq(sessionSandboxes.sandboxId, row.sandboxId),
                eq(sessionSandboxes.status, 'stopped'),
                sql`${sessionSandboxes.metadata}->>'providerStopPendingAt' = ${stopPendingAt}`,
                sql`${sessionSandboxes.metadata}->>'runtimeWakeId' IS NULL`,
              ),
            )
            .for('update')
            .limit(1);
          if (!owned) return;

          // Hold the row lock through the external stop. A concurrent wake
          // cannot claim and start this runtime between our check and pause.
          if (action === 'stop-pending') {
            await getProvider(row.provider as SandboxProviderName).stop(externalId);
          }
          await endComputeSession(row.sandboxId);
          await tx
            .update(sessionSandboxes)
            .set({
              metadata: sql`(
                coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
                  - 'providerStopPendingAt'
                ) || ${JSON.stringify({ parkedVerifiedAt: now.toISOString() })}::jsonb`,
              updatedAt: now,
            })
            .where(eq(sessionSandboxes.sandboxId, row.sandboxId));
        });
        continue;
      }

      if (action === 'verified') {
        // Stamp only. Rotation depends on this, so it must happen even when
        // nothing interesting was found.
        await db
          .update(sessionSandboxes)
          .set({
            metadata: sql`(
              coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
                - 'providerStopPendingAt'
              ) || ${JSON.stringify({ parkedVerifiedAt: now.toISOString() })}::jsonb`,
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
