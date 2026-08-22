/**
 * Syncing OUR rows to the provider's real state, keyed by external id.
 *
 * These are the deterministic billing-close paths shared by the provider
 * webhook ingress (the fast path, closing billing the instant a provider says a
 * box stopped) and the reaper sweep (the backstop that runs even when an event
 * is dropped). Idempotent by construction: a row already stopped/archived is a
 * no-op, so the two paths can race freely.
 */

import { projectSessions, sessionSandboxes } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { pauseComputeSession } from '../../billing/services/compute-metering';
import { revokeSessionConnectorTokens } from '../../repositories/account-tokens';
import { invalidateProviderCache } from '../../sandbox-proxy';
import { db } from '../../shared/db';
import { preserveEstablishedRuntime } from '../runtime-identity';
import { settleOpenSandboxTurns, storedSandboxTurns } from '../sandbox-turn-lifecycle';
import { requeueAbandonedPrompt } from '../session-lifecycle/redelivery';
import { runtimeWakeInProgress } from '../session-lifecycle/runtime-wake-fence';
import type { StopReason } from '../stop-reason';

/** Merge keys into a jsonb metadata column without clobbering siblings. */
export function mergeMetadata(patch: Record<string, unknown>) {
  return sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
}

/**
 * How long a first provider-`stopped` observation must age before a second one
 * may park a box that still holds turn authority.
 *
 * SIZED FROM A MEASURED TRANSITION, not from the renewal cadence. It was
 * 15_000, chosen so two reads could not fall inside one provider transition —
 * but a Platinum lifecycle transition outlasts that, so both reads landed
 * inside it and the guard expired mid-transition instead of covering it.
 *
 * Incident 2026-08-21T23:58Z (session 541ea985, Platinum sbx_01M0JE5DDBE9JCZ):
 * parked at 23:58:37 with `provider_reconcile`, and the SAME box reported
 * running again at 23:58:47 — ten seconds later. The guest never rebooted
 * (uptime spanned the whole window) and OpenCode never restarted, so nothing
 * had actually gone away; a live turn was destroyed by a state field read
 * during a transition. That session lost five turns to this in one day.
 *
 * 60s covers the observed transition with margin. The cost is bounded and
 * one-sided: a GENUINELY stopped box mid-turn waits up to a minute longer to
 * park, while a box that is merely transitioning keeps the user's work.
 */
export const MIDTURN_STOP_CONFIRMATION_MS = 60_000;

export type StoppedObservationDecision = 'park' | 'await_confirmation';

/**
 * May a single provider-`stopped` read park this box?
 *
 * Incident 2026-08-17T20:40:03Z (session 0fc6897a, Daytona f468056d): it did,
 * mid-turn, `stopReason: provider_reconcile` — while Daytona's own
 * `autoStopInterval` was 720 minutes and nothing had asked for a stop.
 * `stopping` and `pending_stop` both map to `stopped`
 * (platform/providers/daytona-state.ts), so a box mid-transition — or one
 * transient misread — settled its turns `runtime_gone` and kicked its client to
 * the wake flow with the turn's work lost.
 *
 * This is `runtimeWakeInProgress` mirrored to the stop direction, with the same
 * asymmetry: uncertainty must fail toward the LIVE box. So a marker that cannot
 * be read is not a confirmation — it is re-recorded (see
 * {@link markPendingStopObservation}) rather than trusted.
 *
 * A box with NO turn authority parks on the first read, exactly as before. An
 * idle box must not gain a pass of latency: its meter runs for that pass.
 */
export function decideStoppedObservation(
  metadata: Record<string, unknown> | null | undefined,
  now: Date,
): StoppedObservationDecision {
  if (storedSandboxTurns(metadata).length === 0) return 'park';
  const observedAtMs = Number(metadata?.pendingStopObservedAtMs);
  if (!Number.isFinite(observedAtMs) || observedAtMs <= 0) return 'await_confirmation';

  // POSITIVE LIVENESS OUTRANKS A STATE FIELD. `providerRunningConfirmedAt` is
  // written when the provider confirms the box RUNNING (routes/shared.ts). A
  // confirmation stamped at or after the pending-stop observation is direct
  // evidence the box outlived the reading that suspected it, so the suspicion
  // is stale no matter how long ago it was recorded — waiting out a clock would
  // park a box we have since watched run.
  //
  // This is the same asymmetry the window encodes, made explicit: uncertainty
  // fails toward the LIVE box. In the 2026-08-21 incident the running
  // confirmation landed ten seconds after the park, and consulting it would
  // have saved the turn on its own.
  const confirmedAtMs = Date.parse(String(metadata?.providerRunningConfirmedAt ?? ''));
  if (Number.isFinite(confirmedAtMs) && confirmedAtMs >= observedAtMs) return 'await_confirmation';

  return now.getTime() - observedAtMs >= MIDTURN_STOP_CONFIRMATION_MS
    ? 'park'
    : 'await_confirmation';
}

/**
 * Record the FIRST stopped observation of a box that still holds a turn.
 *
 * A CAS, not a stamp: the write lands only while the row carries no readable
 * marker. A pass that rewrote the instant every time would restart the
 * confirmation window for ever and the box could never park at all. The same
 * predicate lets a garbage value be replaced, so an unreadable marker cannot
 * strand a box either.
 *
 * TAKES NO CLOCK. The window measures the distance between two OBSERVATIONS, so
 * it must start at the instant this one happened. The reaper captures one `now`
 * at pass start and carries it through a batch of up to 100 provider
 * round-trips; stamping that value backdates the window by however long the
 * pass took to reach the row, and a slow pass plus one read from either of the
 * other two observers then confirms a park inside a SINGLE provider transition
 * — exactly what the 15s window exists to make impossible.
 *
 * The status arm matches every row the gate is applied to, not just `active`.
 * `claimInPlaceRuntimeRecovery` (projects/runtime-identity.ts) sets
 * `provisioning` while KEEPING `external_id` and the whole metadata object, so
 * such a row holds turn authority, `beginSandboxTurn` accepts it, and
 * `reconcileSandboxStoppedByExternalId` reaches this write for it. A CAS that
 * matched only `active` wrote nothing there, so the decision stayed
 * `await_confirmation` for ever: the row never parked and its ledger rows
 * claimed a turn was running for the rest of time.
 *
 * Best-effort by construction — a lost marker costs one more pass of
 * confirmation, never a wrong park.
 */
export async function markPendingStopObservation(sandboxId: string): Promise<void> {
  const observedAt = new Date();
  await db
    .update(sessionSandboxes)
    .set({
      metadata: mergeMetadata({ pendingStopObservedAtMs: observedAt.getTime() }),
      updatedAt: observedAt,
    })
    .where(
      and(
        eq(sessionSandboxes.sandboxId, sandboxId),
        sql`${sessionSandboxes.status} IN ('active', 'provisioning')`,
        sql`(
          ${sessionSandboxes.metadata}->>'pendingStopObservedAtMs' IS NULL
          OR ${sessionSandboxes.metadata}->>'pendingStopObservedAtMs' !~ '^[0-9]+$')`,
      ),
    )
    .catch((err) =>
      console.warn(
        `[reaper] pending stop marker failed for ${sandboxId}:`,
        err instanceof Error ? err.message : err,
      ),
    );
}

/**
 * Drop the pending marker: the provider says this box is running.
 *
 * A confirmation is about ONE provider transition, so a `running` answer ends
 * it. Without that, a box that survived a transient `stopped` read carries an
 * aged marker, and the NEXT transient read — minutes or hours later, mid a
 * different turn, with hundreds of healthy reads in between — parks it on what
 * is really one observation.
 *
 * EVERY OBSERVER THAT POLLS MUST CALL THIS, and both do: the reaper's status
 * poll (reaping/box-reaper.ts, the 20s active-turn lane, which visits every row
 * holding turn authority) and the session access path
 * (projects/routes/shared.ts, polled ~1/s by the web client). Only those two can
 * ARM a marker repeatedly. The webhook ingress can arm one on a transitional
 * `stopping` delivery, and either poller drops it on its next running read.
 */
export async function clearPendingStopObservation(sandboxId: string): Promise<void> {
  await db
    .update(sessionSandboxes)
    .set({
      metadata: sql`coalesce(${sessionSandboxes.metadata}, '{}'::jsonb) - 'pendingStopObservedAtMs'`,
      updatedAt: new Date(),
    })
    .where(eq(sessionSandboxes.sandboxId, sandboxId))
    .catch((err) =>
      console.warn(
        `[reaper] pending stop marker clear failed for ${sandboxId}:`,
        err instanceof Error ? err.message : err,
      ),
    );
}

export interface StoppedStateWrite {
  sandboxId: string;
  sessionId: string;
  externalId: string | null;
  /** WHY this box parked. Required — the classification query groups on it. */
  stopReason: StopReason;
  /** Extra keys to record about the stop. Merged, never assigned. */
  metadata?: Record<string, unknown>;
  now?: Date;
}

/**
 * THE stop write. Every path that parks a sandbox — the reaper's idle stop, the
 * reaper's provider-confirmed reconcile, the webhook ingress, the user's manual
 * stop — goes through this one function.
 *
 * It exists because the procedure used to be copy-pasted three times and had
 * already drifted: two copies merged the metadata patch into the jsonb column,
 * the third assigned a whole object built from a row read moments earlier, which
 * silently dropped anything a concurrent writer had put there in between (the
 * `runtimeWakeId` fence and the `lastAliveAt` liveness stamp the billing clamp
 * depends on both live in that column). And the money-critical step order —
 * settle the meter against the still-active row BEFORE flipping the status —
 * was recorded as a comment repeated in each copy. A comment is not a mechanism;
 * a single function is.
 *
 * So, in order, and nowhere else:
 *   1. close the compute window while the row still says `active`, so the final
 *      window is settled against the state it was actually billed under;
 *   2. flip `session_sandboxes` and `project_sessions` in ONE transaction, so
 *      there is no window where the box is parked but the session still claims
 *      to be running (and no way for a caller to do one and forget the other),
 *      and settle every still-open `session_turns` row of this sandbox in that
 *      SAME transaction — the statement below erases the turn authority those
 *      rows are settled against, so this is the last moment anything can;
 *   3. drop the proxy's provider cache.
 * Metadata is ALWAYS a jsonb merge — this module has no whole-object writer.
 */
export async function applyStoppedState(write: StoppedStateWrite): Promise<void> {
  const now = write.now ?? new Date();
  // Read the turn authority BEFORE the statement below erases it: a delivery
  // that was still in flight when the box parked never became a turn, and its
  // inbox prompt has to be given back. After the erasure there is nothing left
  // to identify those deliveries by.
  const [before] = await db
    .select({ metadata: sessionSandboxes.metadata })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sandboxId, write.sandboxId))
    .limit(1);
  const abandonedDeliveries = storedSandboxTurns(before?.metadata).filter(
    (turn) => turn.state === 'delivering' && turn.messageId,
  );
  await pauseComputeSession(write.sandboxId).catch((err) =>
    console.warn(
      `[reaper] pauseComputeSession failed for ${write.sandboxId}:`,
      err instanceof Error ? err.message : err,
    ),
  );
  const patch = {
    ...(write.metadata ?? {}),
    stopReason: write.stopReason,
    stoppedAt: now.toISOString(),
  };
  await db.transaction(async (tx) => {
    await tx
      .update(sessionSandboxes)
      .set({
        status: 'stopped',
        updatedAt: now,
        // A committed stop cancels any in-flight wake. If provider.start()
        // resolves after this transaction, its fenced completion write loses
        // and the resume path stops the provider again. This makes an explicit
        // user stop win both orderings of the start/stop race.
        //
        // `patch` always carries stopReason + stoppedAt, so this is never an
        // empty merge. The same statement drops wake fences and every turn
        // authority record. A provider webhook can win the idle-stop race
        // before the reaper clears an unknown turn. A stopped sandbox cannot
        // retain authority that a later resume could misread. Still a MERGE,
        // never a whole-object assign — a concurrent writer's lastAliveAt lives
        // in this column too.
        //
        // `pendingStopObservedAtMs` goes with them: a box that is parked, woken,
        // and given a new turn must earn its confirmation again from scratch, or
        // the stale marker parks it on the first transient stopped read.
        metadata: sql`(coalesce(${sessionSandboxes.metadata}, '{}'::jsonb)
          - 'runtimeWakeStartedAt'
          - 'runtimeWakeId'
          - 'runtimeWakeLeaseExpiresAt'
          - 'runtimeWakeProviderStatus'
          - 'runtimeWakeCleanupId'
          - 'runtimeWakeCleanupLeaseExpiresAt'
          - 'activeTurn'
          - 'activeTurns'
          - 'pendingStopObservedAtMs'
          - 'lifecycleStopClaim') || ${JSON.stringify(patch)}::jsonb`,
      })
      .where(eq(sessionSandboxes.sandboxId, write.sandboxId));
    await tx
      .update(projectSessions)
      .set({ status: 'stopped', updatedAt: now })
      .where(eq(projectSessions.sessionId, write.sessionId));
    // A turn that was in flight when the box parked ended because the runtime
    // went away — that is precisely what `end_reason = 'runtime_gone'` records.
    // Keyed by sandbox, not by token: the statement above just deleted the
    // `activeTurns` entry every token-scoped settle CASes against, so nothing
    // after this transaction could ever close these rows and they would claim a
    // turn is still running forever. In the transaction on purpose — a stop
    // that is not durable together with its ledger settle recreates the bug —
    // and inside a SAVEPOINT, so this observation table can never abort a stop
    // whose provider box is already off (see settleOpenSandboxTurns).
    await settleOpenSandboxTurns(tx, write.sandboxId, 'runtime_gone');
  });
  // AFTER the commit: the requeued prompt must not race the authority it is
  // replacing. Best-effort — a stop that is already durable must never be
  // failed by a repair, and the reaper's own pass reaches the same rows.
  //
  // HELD, not due. This box was just parked — by the idle reaper, by a
  // provider-confirmed stop, or by the user pressing stop. A due-now row would
  // be claimed by the very next scheduler tick, and `continueSession` would
  // wake the runtime the stop just shut down and bill the account for it, up to
  // three times. The prompt is durable and visible in the composer's queue; the
  // user's next send, or "send now" on the row, releases it.
  for (const turn of abandonedDeliveries) {
    await requeueAbandonedPrompt({
      sessionId: write.sessionId,
      wireMessageId: turn.messageId,
      turnToken: turn.token,
      endReason: 'runtime_gone',
      hold: true,
    }).catch((err) =>
      console.warn(
        `[reaper] prompt redelivery failed after stopping ${write.sandboxId}:`,
        err instanceof Error ? err.message : err,
      ),
    );
  }
  if (write.externalId) invalidateProviderCache(write.externalId);
}

export interface StoppedReconcileOptions {
  /**
   * Is this an UNSOLICITED provider observation, rather than the consequence of
   * a stop this control plane just issued?
   *
   * Only an observation can be a misread, and only an observation may be made
   * to wait for a second one while a turn is open. Three callers pass it: the
   * provider webhook ingress (platform/webhooks/sandbox-webhooks.ts, whose
   * `classifyLifecycle` maps the transitional `stopping` / `archiving` straight
   * to `stopped`), the session access path in projects/routes/shared.ts — which
   * polls `provider.getStatus` every second and stops nothing itself, and which
   * therefore authored the 2026-08-17 mid-turn park — and, through its own copy
   * of the same gate, the reaper's status poll. All three read the row back and
   * must handle it still being `active`.
   *
   * Every other caller has ALREADY stopped the box and must park the row
   * unconditionally, or it keeps billing against a box that is off: account
   * deletion (billing/services/account-deletion.ts) and the orphan-box sweep
   * (reaping/orphan-boxes.ts), both of which call `provider.stop()` first.
   * Default false for exactly that reason: a caller that forgets this flag gets
   * today's behaviour, never a row left active against a dead box.
   */
  confirmMidTurnStop?: boolean;
}

/**
 * Close billing + reconcile a sandbox the PROVIDER reports stopped/archived,
 * keyed by external id. Returns true if it transitioned a live row.
 */
export async function reconcileSandboxStoppedByExternalId(
  externalId: string,
  now = new Date(),
  options: StoppedReconcileOptions = {},
): Promise<boolean> {
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      status: sessionSandboxes.status,
      metadata: sessionSandboxes.metadata,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  if (!row) return false;
  if (row.status === 'stopped' || row.status === 'archived') return false;
  if (runtimeWakeInProgress(row.metadata, now)) return false;
  // While a turn is open, one OBSERVED `stopped` is not proof — see
  // decideStoppedObservation. The order is fixed: already-stopped, then the wake
  // fence, then this confirmation, then the durable stop.
  if (
    options.confirmMidTurnStop === true &&
    decideStoppedObservation(row.metadata, now) === 'await_confirmation'
  ) {
    console.warn(
      `[reaper] provider reported ${externalId} stopped mid-turn; awaiting confirmation`,
      { sandboxId: row.sandboxId, sessionId: row.sessionId },
    );
    await markPendingStopObservation(row.sandboxId);
    return false;
  }
  // A stopped box stays stopped: passive /v1/p traffic (markSandboxUsed heal /
  // wakeSandbox) must not resurrect it. That used to need an `idleQuiesced`
  // flag written here; the heal now refuses any row whose deadline has passed —
  // the same rows, one fewer piece of state.
  await applyStoppedState({
    sandboxId: row.sandboxId,
    sessionId: row.sessionId,
    externalId,
    stopReason: 'provider_reconcile',
    now,
  });
  return true;
}

/**
 * The provider reports the box destroyed/deleted/lost — finalize billing and
 * preserve the original mapping. Keyed by external id; idempotent. Shared by
 * webhook ingress + reaper.
 */
export async function reconcileSandboxRemovedByExternalId(
  externalId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({
      sandboxId: sessionSandboxes.sandboxId,
      sessionId: sessionSandboxes.sessionId,
      accountId: sessionSandboxes.accountId,
      externalId: sessionSandboxes.externalId,
      metadata: sessionSandboxes.metadata,
      status: sessionSandboxes.status,
    })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.externalId, externalId))
    .limit(1);
  if (!row) return false;
  if (!row.externalId) return false;
  await preserveEstablishedRuntime(row, 'provider_webhook_removed', 'provider_removed', now);
  // The box is GONE at the provider — unlike an idle stop, nothing can wake it,
  // so its connector token is now a bearer credential with no owner. Nothing
  // else ever expires these (no expiresAt, exempt from PAT idle-revoke).
  await revokeSessionConnectorTokens(row.sessionId, row.accountId).catch((err) =>
    console.error(
      `[reaper] FAILED to revoke connector tokens for removed sandbox ${externalId} (session ${row.sessionId}):`,
      err,
    ),
  );
  invalidateProviderCache(externalId);
  return true;
}
