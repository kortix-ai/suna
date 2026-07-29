/**
 * Provider-agnostic sandbox reaper + state/billing reconciler.
 *
 * ONE RULE for running boxes: ask the box itself. Each pass probes the box's
 * own opencode session status (sandbox-busy-probe.ts):
 *
 *   busy/retry → alive. Disarm the idle countdown, stamp lastTurnAt.
 *   idle       → the first observation ARMS `metadata.idleObservedAt`; the
 *                stop fires only once the box has stayed OBSERVABLY idle for
 *                the full TTL. The TTL counts from real idleness — never from
 *                a heuristic like "last LLM call", which can predate the turn
 *                end by a whole tool run (the 2026-06-24 mid-session kills).
 *   unknown    → unreachable / legacy box. Fall back to the activity clock
 *                (lastTurnAt | row creation | last LLM usage_event + TTL) so a
 *                wedged daemon can't hold compute billing open forever.
 *
 * Trigger-fired boxes (metadata.source 'trigger:*') confirm idle on a shorter
 * TTL — nobody is waiting on a webhook/cron box.
 *
 * Passive traffic (an open tab streaming events, /v1/p proxy hits, repeated
 * /start polls) is deliberately NEVER treated as activity — trusting it is
 * what once kept idle boxes alive for days (verified live 2026-06-21: 1,597
 * phantom-active compute rows). The provider's own auto-stop timer survives
 * only as the orphan backstop (providerAutoStopBackstopMinutes): its "no
 * inbound requests" signal is blind to local tool runs, so it sits well above
 * the reaper's TTL and matters only when this API is dead.
 *
 * Provider webhooks are the fast path that closes billing the instant a box
 * stops; this reaper is the deterministic backstop that runs even if an event
 * is dropped — together they make "idle for the TTL → stopped, and never
 * billed while stopped" an invariant rather than a best-effort.
 */

import { logger } from '../../lib/logger';
import { getProvider, type SandboxStatus } from '../../platform/providers';
import { invalidateProviderCache } from '../../sandbox-proxy';
import { markComputeSessionAlive } from '../../billing/services/compute-metering';
import { hasActiveExecutionLease } from '../execution-lease';
import { preserveEstablishedRuntime } from '../runtime-identity';
import { REAP_CONCURRENCY } from '../reaper-constants';
import {
  autoStopTtlMs,
  decideHardStop,
  decideReconcile,
  hardStopCeilingMs,
  hardStopEnabled,
  isTriggerSession,
  lastMeaningfulAt,
  provenActivityAt,
  triggerAutoStopTtlMs,
} from './policy';
import { applyStoppedState } from './sandbox-state-sync';
import { reapRunningBox } from './running-box';
import {
  countReapCandidates,
  loadLastUsageBySession,
  loadOrphanAccountIds,
  markReaperVisited,
  reapCandidatePredicate,
  selectReapCandidates,
} from './box-queries';

export interface ReapResult {
  candidates: number;   // rows this pass actually examined (capped by the batch)
  matching: number;     // rows matching the candidate predicate platform-wide
  deferred: number;     // matching - candidates: rotated to a later pass, NOT starved
  stopped: number;      // we issued a provider.stop() for an idle box
  hardStopped: number;  // stopped by the ABSOLUTE ceiling (lease/probe bypassed)
  reconciled: number;   // provider already not-running; we synced our row
  billingClosed: number;
  skipped: number;
  warmSkipped: number;  // unclaimed warm-pool box, exempt from the idle TTL only
  busyVetoed: number;   // idle-by-clock but the box itself reported a running turn
  idleArmed: number;    // first probe-confirmed idle observation — TTL countdown started
  errors: number;
}

export const EMPTY_REAP_RESULT: ReapResult = {
  candidates: 0,
  matching: 0,
  deferred: 0,
  stopped: 0,
  hardStopped: 0,
  reconciled: 0,
  billingClosed: 0,
  skipped: 0,
  warmSkipped: 0,
  busyVetoed: 0,
  idleArmed: 0,
  errors: 0,
};

/**
 * One reaper pass over active session sandboxes. For each:
 *   - ask the provider its REAL state,
 *   - reconcile our row + close billing if it is not running,
 *   - otherwise apply the running-box rule (probe → busy alive / idle countdown).
 * Bounded concurrency so a batch of provider round-trips doesn't serialize.
 *
 * ORPHAN-ACCOUNT BYPASS: a box whose owning account has been deleted keeps
 * heartbeating forever otherwise — the execution-lease renewal clears
 * `idleObservedAt` and short-circuits the pass before the probe (see the module
 * header), so the idle clock can never accumulate and the box is never even
 * probed. There is no customer behind a deleted account whose
 * in-flight tool call this would interrupt, so for orphaned rows ONLY this
 * pass skips the lease short-circuit and tells `reapRunningBox` to skip the
 * busy probe too, going straight to `provider.stop()`. Every non-orphan row
 * keeps the full lease + busy-probe protection unchanged. Gated by
 * KORTIX_ORPHAN_ACCOUNT_REAP_ENABLED (default on); a failed account lookup
 * fails safe to "no orphans this pass" rather than guessing.
 */
export async function reapAndReconcileSandboxes(now = new Date()): Promise<ReapResult> {
  const ttlMs = autoStopTtlMs();
  const triggerTtlMs = triggerAutoStopTtlMs();
  const ceilingMs = hardStopCeilingMs();
  const ceilingEnabled = hardStopEnabled();
  const orphanAccountBypassEnabled = process.env.KORTIX_ORPHAN_ACCOUNT_REAP_ENABLED !== 'false';

  const candidatePredicate = reapCandidatePredicate();
  const rows = await selectReapCandidates(candidatePredicate);

  const result: ReapResult = { ...EMPTY_REAP_RESULT, candidates: rows.length, matching: rows.length };
  if (rows.length === 0) return result;

  result.matching = await countReapCandidates(candidatePredicate, rows.length);
  result.deferred = Math.max(0, result.matching - rows.length);

  // Batched fallback signal: last LLM call per session (indexed usage_events).
  // Only consulted for boxes the probe can't reach; null = the lookup itself
  // failed this pass, and unreachable boxes are then skipped (fail safe).
  const lastUsageBySession = await loadLastUsageBySession(rows.map((r) => r.sessionId));
  // Batched, once per pass (bounded by REAP_BATCH_SIZE like everything else
  // here — the shared REAP_CONCURRENCY cap keeps any resulting stop() calls
  // from hammering the provider even if every row in the batch is an orphan).
  const orphanAccountIds = orphanAccountBypassEnabled
    ? await loadOrphanAccountIds(rows.map((r) => r.accountId))
    : new Set<string>();

  let orphanCandidates = 0;
  let orphanStopped = 0;

  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        // The ABSOLUTE ceiling, computed from unforgeable evidence only. A
        // failed usage lookup yields null → no hard stop this pass (fail safe).
        const proven =
          lastUsageBySession === null
            ? null
            : provenActivityAt(row, lastUsageBySession.get(row.sessionId) ?? null);
        const hardStop = decideHardStop({
          provenActivityAt: proven,
          now,
          ceilingMs,
          enabled: ceilingEnabled,
        });

        // An unclaimed warm-pool box has never had a prompt, so the idle TTL
        // would stop it the moment it was baked — it is exempt from that, but
        // NOT from the ceiling. A warm box nobody claimed within the ceiling is
        // pure billed dead time (measured live: warm 'available' boxes holding
        // OPEN compute rows while the reaper skipped them outright).
        if (row.warmState === 'available' && !hardStop) {
          result.warmSkipped += 1;
          result.skipped += 1;
          continue;
        }

        const providerStatus: SandboxStatus = await getProvider(row.provider).getStatus(row.externalId);

        if (providerStatus === 'running') {
          // A CONTROL-PLANE observation that this box is alive — the only thing
          // that lets its compute window keep billing. Absence of this stamp is
          // what stops the meter automatically (billing/services/compute-liveness.ts),
          // so it must be recorded here and nowhere the sandbox itself can reach.
          await markComputeSessionAlive(row.sandboxId, now).catch((err) =>
            console.warn(
              `[reaper] liveness stamp failed for ${row.sandboxId}:`,
              err instanceof Error ? err.message : err,
            ),
          );
          const isOrphanAccount = !!row.accountId && orphanAccountIds !== null && orphanAccountIds.has(row.accountId);
          if (isOrphanAccount) orphanCandidates += 1;

          // The execution lease is written by the box's OWN heartbeat, so it may
          // defer a stop, never prevent one past the ceiling. Doubly bounded
          // since 2026-07-29: the API also refuses to renew a lease held longer
          // than execution-lease.ts `maxLeaseHeldMs`, so a wedged/retrying daemon
          // stops being able to write this veto at all.
          if (!isOrphanAccount && !hardStop && hasActiveExecutionLease(row.metadata, now)) {
            result.busyVetoed += 1;
            continue;
          }
          let fallbackLastMeaningful: Date | null = null;
          if (lastUsageBySession !== null) {
            const base = lastMeaningfulAt(row);
            const usage = lastUsageBySession.get(row.sessionId);
            fallbackLastMeaningful = usage && usage.getTime() > base.getTime() ? usage : base;
          }
          const outcome = await reapRunningBox(row, {
            now,
            ttlMs: isTriggerSession(row.metadata) ? triggerTtlMs : ttlMs,
            fallbackLastMeaningful,
            bypassBusyProbe: isOrphanAccount || hardStop,
          });
          result[outcome] += 1;
          if (outcome === 'stopped') {
            result.billingClosed += 1;
            if (isOrphanAccount) orphanStopped += 1;
            if (hardStop) {
              result.hardStopped += 1;
              logger.warn('[reaper] ABSOLUTE CEILING stop — no proven activity within the ceiling', {
                sandbox_id: row.sandboxId,
                proven_idle_ms: proven ? now.getTime() - proven.getTime() : null,
                ceiling_ms: ceilingMs,
                had_execution_lease: hasActiveExecutionLease(row.metadata, now),
              });
            }
          }
          continue;
        }

        // ── Not running: reconcile our row to the provider's real state.
        switch (decideReconcile(providerStatus)) {
          case 'none':
            result.skipped += 1;
            break;
          case 'reconcile-stopped':
            // Quiesce even a provider-confirmed stop: a Daytona native auto-stop
            // (or a webhook/reaper stop) must NOT be resurrected by passive /v1/p
            // traffic (markSandboxUsed heals unflagged stopped rows). It comes
            // back only on an explicit open / real turn, which clears the flag.
            await applyStoppedState({
              sandboxId: row.sandboxId,
              sessionId: row.sessionId,
              externalId: row.externalId,
              quiesce: true,
              now,
            });
            result.reconciled += 1;
            result.billingClosed += 1;
            break;
          case 'reconcile-removed':
            // A provider 404 can be a transient archive/restore observation.
            // Preserve the established identity; never turn this signal into a
            // fresh, empty sandbox for the same session.
            await preserveEstablishedRuntime(row, 'provider_reported_removed', now);
            invalidateProviderCache(row.externalId);
            result.reconciled += 1;
            result.billingClosed += 1;
            break;
        }
      } catch (err) {
        result.errors += 1;
        console.error(`[reaper] failed for sandbox ${row.sandboxId}: ${(err as Error)?.message ?? err}`);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(REAP_CONCURRENCY, rows.length) }, worker));
  // Rotate the batch window — see markReaperVisited for why every examined row
  // is stamped, including the ones this pass deliberately left alone.
  await markReaperVisited(rows.map((r) => r.sandboxId), now);
  if (orphanCandidates > 0) {
    console.log('[reaper] orphan-account sweep', { candidates: orphanCandidates, stopped: orphanStopped });
  }
  if (result.deferred > 0) {
    console.log('[reaper] batch saturated — remaining rows rotate to the next pass', {
      matching: result.matching,
      examined: result.candidates,
      deferred: result.deferred,
    });
  }
  return result;
}
