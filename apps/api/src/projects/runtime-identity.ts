import { sessionSandboxes } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

import { endComputeSession, reopenComputeForSandbox } from '../billing/services/compute-metering';
import { logger } from '../lib/logger';
import { captureException } from '../lib/sentry';
import { getProvider, type ProviderName } from '../platform/providers';
import { db } from '../shared/db';
import { settleOpenSandboxTurns } from './session-turn-ledger';
import type { StopReason } from './stop-reason';
import {
  STAMPED_RUNTIME_FAILURE_STOP_REASONS,
  runtimeStartFailurePatch,
} from './session-lifecycle/runtime-wake-fence';
import {
  STOPPED_SANDBOX_CLEARED_KEYS,
  patchedSandboxMetadata,
  transitionRuntime,
} from './session-lifecycle/status-transitions';
import {
  STOP_CLAIM_KEY,
  holdsStopClaim,
  noLiveStopClaim,
  stopClaimMetadata,
} from './session-lifecycle/stop-claim';
import { PROVIDER_REMOVAL_PENDING_KEY } from './reaping/archived-box-removal';
import { isAlreadyNotRunning } from './reaping/policy';
import { sessionHoldsTurnAuthority } from './session-lifecycle/inbox-admission';

export const RUNTIME_IDENTITY_UNAVAILABLE = 'runtime_identity_unavailable';
/** Stable alert key. Better Stack / Sentry rules match on this, not on prose. */
export const RUNTIME_LOST_EVENT = 'runtime.lost';
export const RUNTIME_IDENTITY_ERROR =
  'The original sandbox is unavailable. Its identity was preserved and no replacement sandbox was created.';

type RuntimeIdentityRow = Pick<
  typeof sessionSandboxes.$inferSelect,
  'sandboxId' | 'sessionId' | 'externalId' | 'metadata'
> & { status?: string | null };

/**
 * Stamped on a row BEFORE Kortix asks the provider to stop/remove its box
 * (account deletion). The provider's `removed` webhook can land before the
 * deleting request settles the row; this stamp tells the classifier the removal
 * is ours, not a lost runtime.
 */
export const KORTIX_REMOVAL_INTENT_KEY = 'kortixRemovalIntentAt';

/** A removal Kortix itself started: deleted/archived session or account teardown. */
export function isKortixInitiatedRemoval(row: Pick<RuntimeIdentityRow, 'status' | 'metadata'>): boolean {
  const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
  return (
    row.status === 'archived' ||
    metadata[KORTIX_REMOVAL_INTENT_KEY] != null ||
    metadata[PROVIDER_REMOVAL_PENDING_KEY] != null
  );
}

type RecoverableRuntimeIdentityRow = typeof sessionSandboxes.$inferSelect;

const RECOVERY_LEASE_MS = 10 * 60 * 1000;

/** The recovery lease keys. Every write that ends a recovery drops them. */
const RECOVERY_LEASE_KEYS = [
  'runtimeRecoveryLeaseId',
  'runtimeRecoveryLeaseAt',
  'runtimeRecoveryLeaseExpiresAtMs',
] as const;

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
  const claimed = await transitionRuntime({
    sessionId: row.sessionId,
    sandboxId: row.sandboxId,
    session: 'provision',
    sandbox: 'provision',
    at: now,
    error: null,
    metadata: {
      merge: {
        runtimeIdentityState: 'recovery_claimed',
        runtimeRecoveryLeaseId: leaseId,
        runtimeRecoveryLeaseAt: now.toISOString(),
        runtimeRecoveryLeaseExpiresAtMs: now.getTime() + RECOVERY_LEASE_MS,
        preservedExternalId: externalId,
      },
    },
    guard: and(
      eq(sessionSandboxes.externalId, externalId),
      sql`CASE WHEN jsonb_typeof(${sessionSandboxes.metadata}->'runtimeRecoveryLeaseExpiresAtMs') = 'number' THEN (${sessionSandboxes.metadata}->>'runtimeRecoveryLeaseExpiresAtMs')::numeric ELSE 0 END < ${now.getTime()}`,
    ),
  });
  return claimed ? { row: { ...claimed, externalId }, leaseId } : null;
}

/** Persist provider acceptance only if this request still owns the recovery fence. */
export async function markInPlaceRuntimeRecoveryAccepted(
  claim: RuntimeRecoveryClaim,
  recovery: 'running' | 'recovering',
  now = new Date(),
): Promise<RecoverableRuntimeIdentityRow | null> {
  const running = recovery === 'running';
  const updated = await transitionRuntime({
    sessionId: claim.row.sessionId,
    sandboxId: claim.row.sandboxId,
    session: running ? 'resume' : 'provision',
    sandbox: running ? 'activate' : 'provision',
    at: now,
    error: null,
    metadata: {
      strip: [
        'runtimeUnavailableReason',
        'runtimeUnavailableAt',
        ...(running ? RECOVERY_LEASE_KEYS : []),
      ],
      merge: {
        runtimeIdentityState: running ? 'recovered' : 'recovering',
        runtimeRecoveryStartedAt: now.toISOString(),
        preservedExternalId: claim.row.externalId,
      },
    },
    guard: and(
      eq(sessionSandboxes.externalId, claim.row.externalId),
      sql`${sessionSandboxes.metadata}->>'runtimeRecoveryLeaseId' = ${claim.leaseId}`,
    ),
  });
  if (updated && running) {
    void reopenComputeForSandbox(updated.sandboxId, updated.accountId, updated.sessionId, null, updated.provider as ProviderName).catch(
      (err) =>
        console.warn(`[runtime-identity] compute reopen failed for ${updated.sandboxId}:`, err),
    );
  }
  return updated;
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

  const preserved = await transitionRuntime({
    sessionId: row.sessionId,
    sandboxId: row.sandboxId,
    session: 'park',
    sandbox: 'stop',
    at: now,
    error: RUNTIME_IDENTITY_ERROR,
    metadata: {
      strip: ['needsReprovision', ...RECOVERY_LEASE_KEYS],
      merge: {
        runtimeIdentityState: 'unavailable',
        runtimeUnavailableReason: reason,
        runtimeUnavailableAt: now.toISOString(),
        preservedExternalId: externalId,
        // NOT resumable in place — /start must branch on runtimeIdentityState, not
        // on the bare `stopped` status (see Task 7). WHICH park this is comes from
        // the caller; see the note on the parameter above.
        stopReason,
        stoppedAt: now.toISOString(),
      },
    },
    guard: eq(sessionSandboxes.externalId, externalId),
    // The box is GONE at the provider, so any turn still open ended because
    // the runtime went away. Once the row reads `stopped`, every token-scoped
    // ledger settle refuses it — they all require an active/provisioning row
    // — so this transaction is the last moment the history can be closed.
    // Savepoint-bounded: the park must not become abortable by an
    // observation table (see settleOpenSandboxTurns).
    then: (tx) => settleOpenSandboxTurns(tx, row.sandboxId, 'runtime_gone'),
  });

  if (!preserved) return null;

  // Once per identity. Every open of a lost session runs the removed path and
  // lands here again (the client polls /start every second), and each pass
  // used to report the same loss as a new one.
  const before = (row.metadata as Record<string, unknown> | null) ?? {};
  const alreadyReported =
    before.runtimeIdentityState === 'unavailable' && before.preservedExternalId === externalId;
  if (!alreadyReported) {
    // A removal Kortix started is an expected teardown, not lost user work.
    if (isKortixInitiatedRemoval(row)) {
      logger.info('Session runtime removed by Kortix-initiated teardown', {
        event: 'runtime.removed_expected',
        provider: preserved.provider,
        externalId,
        sandboxId: row.sandboxId,
        sessionId: row.sessionId,
        reason,
        stopReason,
      });
    } else {
      reportLostRuntime(preserved, reason, stopReason, now);
    }
  }
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
 * the whole time.
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
  /**
   * The row's CURRENT metadata, for the consecutive-failure accounting below.
   * Optional so the pure park semantics stay testable without a row.
   */
  metadata?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    stopReason,
    stoppedAt: now.toISOString(),
    runtimeParkReason: reason,
    providerStopPendingAt: now.toISOString(),
    // A park for a FAILED start is a cooldown, not a gravestone. Without this
    // clock `stoppedWakeResult` had nothing to expire, so a `runtime_boot_failed`
    // stamp replayed `stage:"failed"` on every open for as long as the row
    // lived — 10+ hours on SampleCo session 9c8749ac, 2026-08-26, without one
    // provider call. The counter is what escalates the cooldown and eventually
    // earns a terminal card that NAMES the attempts.
    ...((STAMPED_RUNTIME_FAILURE_STOP_REASONS as readonly string[]).includes(stopReason)
      ? runtimeStartFailurePatch(metadata, now)
      : {}),
  };
}

type ParkableRuntimeRow = Pick<
  typeof sessionSandboxes.$inferSelect,
  'sandboxId' | 'sessionId' | 'externalId' | 'metadata' | 'provider' | 'updatedAt'
>;

/**
 * Park an established runtime that FAILED without being lost: stop the
 * provider box, record an ordinary stopped row, and close its compute window.
 * Unlike {@link preserveEstablishedRuntime} it writes no loss flags, so the
 * session stays wakeable and the UI shows the honest "restart it" card. The
 * provider stop is load-bearing, not defensive: the incident's boot-failed
 * boxes stayed RUNNING on both providers after their rows were marked stopped
 * and their metering closed — unmetered compute until a backstop fired.
 *
 * Three steps, and no transaction is open across the provider call:
 *   1. Claim: one UPDATE installs a stop claim on the exact row the caller
 *      read (CAS on `updated_at`). The row stays `active`. A new prompt and an
 *      in-place restart refuse the row while the claim is live.
 *   2. `provider.stop()`.
 *   3. On success, park both rows in one transaction under the same claim,
 *      then close the compute window. On failure, release the claim: the row
 *      is `active` again, exactly as the caller found it, and its metering
 *      stays open because the box may still run.
 *
 * Returns the parked row, or null when the claim was lost or the stop failed.
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
  const token = crypto.randomUUID();

  // A readiness request can outlive the wake it inspected. The wake rewrites
  // this row before starting the provider. No provider or billing side effect
  // is allowed unless this exact snapshot wins.
  const [claimed] = await db
    .update(sessionSandboxes)
    .set({
      metadata: patchedSandboxMetadata({ merge: stopClaimMetadata(token, now) }),
      updatedAt: now,
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, row.sandboxId),
        eq(sessionSandboxes.status, 'active'),
        eq(sessionSandboxes.externalId, externalId),
        eq(sessionSandboxes.updatedAt, row.updatedAt),
        noLiveStopClaim(now),
      ),
    )
    .returning({ sandboxId: sessionSandboxes.sandboxId });
  if (!claimed) return null;

  try {
    await getProvider(row.provider as ProviderName).stop(externalId);
  } catch (err) {
    if (!isAlreadyNotRunning(err)) {
      console.warn(
        `[runtime-identity] provider stop failed while parking ${externalId}; the row stays active:`,
        err instanceof Error ? err.message : err,
      );
      await releaseParkClaim(row.sandboxId, token);
      return null;
    }
  }

  const parked = await transitionRuntime({
    sessionId: row.sessionId,
    sandboxId: row.sandboxId,
    session: 'park',
    sandbox: 'park',
    at: now,
    error: null,
    metadata: {
      // A stopped row keeps no wake fence, turn authority or stop claim.
      strip: ['needsReprovision', ...RECOVERY_LEASE_KEYS, ...STOPPED_SANDBOX_CLEARED_KEYS],
      merge: parkMetadataPatch(
        reason,
        stopReason,
        now,
        (row.metadata as Record<string, unknown>) ?? null,
      ),
    },
    guard: and(eq(sessionSandboxes.externalId, externalId), holdsStopClaim(token)),
    then: async (tx) => {
      // A turn that was open ended with this runtime. The settle remains
      // savepoint-bounded so an observation-table failure cannot abort the
      // park this transaction commits.
      await settleOpenSandboxTurns(tx, row.sandboxId, 'runtime_gone');
    },
  });
  if (!parked) {
    // A deleted session refuses the park. Leave its row to the delete.
    await releaseParkClaim(row.sandboxId, token);
    return null;
  }
  await endComputeSession(row.sandboxId).catch((err) =>
    console.warn(
      `[runtime-identity] failed to close compute for ${row.sandboxId} while parking ${externalId}:`,
      err,
    ),
  );
  return parked;
}

async function releaseParkClaim(sandboxId: string, token: string): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({ metadata: patchedSandboxMetadata({ strip: [STOP_CLAIM_KEY] }) })
    .where(and(eq(sessionSandboxes.sandboxId, sandboxId), holdsStopClaim(token)))
    .catch((err) =>
      console.warn(`[runtime-identity] failed to release the park claim on ${sandboxId}:`, err),
    );
}

type RefusableRuntimeRow = ParkableRuntimeRow & { status: string };

/**
 * Retire an ESTABLISHED runtime that FAILED Rule 4 admission, so the caller can
 * allocate a fresh box on the SAME session — the contract's own words: "a box
 * that fails admission is replaced, not used." `preserveEstablishedRuntimeOnOpen`
 * (routes/shared.ts) used to route admission refusals here through
 * {@link preserveEstablishedRuntime} / {@link parkEstablishedRuntime}, both of
 * which stop the session (`stage:'failed'`) — the opposite of the contract for
 * a box that is merely unserviceable, not lost. Admission refusal is a FIFTH,
 * different population from the four `preserveEstablishedRuntimeOnOpen` already
 * serves, so it gets its own function instead of a flag on that one.
 *
 * Safe to delete the row: the session's durable identity — git branch, commits,
 * server-side transcript — lives outside the box, which materializes from the
 * branch. Nothing durable is lost; the caller re-provisions immediately.
 *
 * Never pulls a box out from under a live turn (Rule 5): refuses up front if
 * turn authority is held (`sessionHoldsTurnAuthority`, the same predicate
 * admission and `GET .../turn` already share), then reuses
 * `parkEstablishedRuntime`'s own claim/stop/settle machinery so a turn that
 * starts in the gap is fenced off by the identical stop claim.
 *
 * Returns false — no claim, no stop, no delete — for: a live turn, a lost CAS
 * race on the claim, a provider stop that genuinely failed (the box may still
 * be running unmetered; leave the row alone rather than delete a row for a box
 * nobody confirmed is off), or a lost race on the delete itself.
 */
export async function retireRefusedRuntime(
  row: RefusableRuntimeRow,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  if (!row.externalId) {
    throw new Error(
      `Cannot retire sandbox ${row.sandboxId} for replacement without an external_id`,
    );
  }
  if (sessionHoldsTurnAuthority({ status: row.status, metadata: row.metadata })) return false;
  const externalId = row.externalId;
  const token = crypto.randomUUID();

  const [claimed] = await db
    .update(sessionSandboxes)
    .set({
      metadata: patchedSandboxMetadata({ merge: stopClaimMetadata(token, now) }),
      updatedAt: now,
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, row.sandboxId),
        eq(sessionSandboxes.status, 'active'),
        eq(sessionSandboxes.externalId, externalId),
        eq(sessionSandboxes.updatedAt, row.updatedAt),
        noLiveStopClaim(now),
      ),
    )
    .returning({ sandboxId: sessionSandboxes.sandboxId });
  if (!claimed) return false;

  try {
    await getProvider(row.provider as ProviderName).stop(externalId);
  } catch (err) {
    if (!isAlreadyNotRunning(err)) {
      console.warn(
        `[runtime-identity] provider stop failed while retiring refused ${externalId} (${reason}); the row stays active:`,
        err instanceof Error ? err.message : err,
      );
      await releaseParkClaim(row.sandboxId, token);
      return false;
    }
  }

  // DELETE first, settle only if it actually won the claim: unlike an UPDATE
  // guarded by `transitionRuntime`, a DELETE that matches zero rows is not an
  // error, so settling before checking the row count would durably close
  // turns for a delete that never happened.
  const deleted = await db.transaction(async (tx) => {
    const rows = await tx
      .delete(sessionSandboxes)
      .where(and(eq(sessionSandboxes.sandboxId, row.sandboxId), holdsStopClaim(token)))
      .returning({ sandboxId: sessionSandboxes.sandboxId });
    if (rows.length === 0) return rows;
    // Savepoint-bounded inside settleOpenSandboxTurns itself: a ledger failure
    // must not undo a delete whose provider box is already stopped.
    await settleOpenSandboxTurns(tx, row.sandboxId, 'runtime_gone');
    return rows;
  });
  if (deleted.length === 0) return false;

  await endComputeSession(row.sandboxId).catch((err) =>
    console.warn(
      `[runtime-identity] failed to close compute for ${row.sandboxId} while retiring refused ${externalId}:`,
      err,
    ),
  );
  return true;
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
