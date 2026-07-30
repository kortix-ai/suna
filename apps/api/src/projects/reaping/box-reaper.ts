/**
 * Provider-agnostic sandbox reaper + state/billing reconciler.
 *
 * ONE RULE for running boxes: `deadline_at <= now()` → stop it.
 *
 * `session_sandboxes.deadline_at` is the control plane's own answer to "when
 * should this box die". It is pushed OUT only by a control-plane-OBSERVED turn
 * start and pulled IN by a sandbox-reported turn end, both in
 * ../sandbox-deadline.ts, and it is bounded by a DB CHECK against an immutable
 * `active_since` anchor. So this pass needs no probe, no lease, no activity
 * clock and no ceiling arithmetic — it reads a number the box cannot forge.
 *
 * WHAT THIS REPLACED, AND WHY
 * ---------------------------
 * Until 2026-07-29 a running box was judged by asking the box: an execution
 * lease the in-sandbox agent renewed every 60s while its local opencode
 * believed ANY session was 'busy' OR 'retry', then a busy probe against that
 * same daemon, with an activity clock the lease renewal also stamped. Three
 * mechanisms, all fed by the subject of the judgement. Measured live: 187
 * genuinely running prod boxes, 156 of which had never emitted a single LLM
 * usage_event, the oldest 264 hours old; `metadata.idleObservedAt` was null on
 * 100% of active rows, meaning the idle-stop path had never fired in production,
 * not once. Deleting all three is the fix; the deadline is what replaces them.
 *
 * Passive traffic (an open tab streaming events, /v1/p proxy hits, repeated
 * /start polls) is still deliberately NEVER treated as activity — trusting it is
 * what once kept idle boxes alive for days (verified live 2026-06-21: 1,597
 * phantom-active compute rows).
 *
 * Provider webhooks are the fast path that closes billing the instant a box
 * stops; this reaper is the deterministic backstop that runs even if an event
 * is dropped — together they make "past its deadline → stopped, and never
 * billed while stopped" an invariant rather than a best-effort.
 */

import { markComputeSessionAlive } from '../../billing/services/compute-metering';
import { type SandboxStatus, getProvider } from '../../platform/providers';
import { invalidateProviderCache } from '../../sandbox-proxy';
import { REAP_CONCURRENCY } from '../reaper-constants';
import { preserveEstablishedRuntime } from '../runtime-identity';
import {
  countReapCandidates,
  markReaperVisited,
  reapCandidatePredicate,
  selectReapCandidates,
} from './box-queries';
import { decideReconcile } from './policy';
import { applyStoppedState } from './sandbox-state-sync';
import { stopExpiredBox } from './stop-box';

export interface ReapResult {
  candidates: number; // rows this pass actually examined (capped by the batch)
  matching: number; // rows matching the candidate predicate platform-wide
  deferred: number; // matching - candidates: rotated to a later pass, NOT starved
  stopped: number; // deadline had passed; we issued a provider.stop()
  reconciled: number; // provider already not-running; we synced our row
  billingClosed: number;
  skipped: number; // deadline still in the future, or provider said 'unknown'
  errors: number;
}

export const EMPTY_REAP_RESULT: ReapResult = {
  candidates: 0,
  matching: 0,
  deferred: 0,
  stopped: 0,
  reconciled: 0,
  billingClosed: 0,
  skipped: 0,
  errors: 0,
};

/**
 * One reaper pass over active session sandboxes. For each:
 *   - ask the provider its REAL state,
 *   - reconcile our row + close billing if it is not running,
 *   - otherwise stop it iff its deadline has passed.
 * Bounded concurrency so a batch of provider round-trips doesn't serialize.
 */
export async function reapAndReconcileSandboxes(now = new Date()): Promise<ReapResult> {
  const candidatePredicate = reapCandidatePredicate();
  const rows = await selectReapCandidates(candidatePredicate);

  const result: ReapResult = {
    ...EMPTY_REAP_RESULT,
    candidates: rows.length,
    matching: rows.length,
  };
  if (rows.length === 0) return result;

  result.matching = await countReapCandidates(candidatePredicate, rows.length);
  result.deferred = Math.max(0, result.matching - rows.length);

  let cursor = 0;
  const worker = async () => {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      try {
        const providerStatus: SandboxStatus = await getProvider(row.provider).getStatus(
          row.externalId,
        );

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
          // THE ONE RULE. `deadline_at` is pushed out only by a
          // control-plane-OBSERVED turn start and pulled in by a
          // sandbox-reported turn end, so this comparison is the whole
          // decision — no probe, no lease, no activity clock, no ceiling
          // arithmetic, and nothing the box itself can influence upward.
          if (row.deadlineAt.getTime() > now.getTime()) {
            result.skipped += 1;
            continue;
          }
          // `row.deadlineAt` and `now` are BOTH from before this row's provider
          // round-trip, so this decision is provisional: stopExpiredBox re-reads
          // the deadline against a fresh clock immediately before issuing the
          // stop, and returns 'skipped' if a prompt arrived in the meantime.
          const outcome = await stopExpiredBox(row, now);
          result[outcome] += 1;
          if (outcome === 'stopped') result.billingClosed += 1;
          continue;
        }

        // ── Not running: reconcile our row to the provider's real state.
        switch (decideReconcile(providerStatus)) {
          case 'none':
            result.skipped += 1;
            break;
          case 'reconcile-stopped':
            await applyStoppedState({
              sandboxId: row.sandboxId,
              sessionId: row.sessionId,
              externalId: row.externalId,
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
        console.error(
          `[reaper] failed for sandbox ${row.sandboxId}: ${(err as Error)?.message ?? err}`,
        );
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(REAP_CONCURRENCY, rows.length) }, worker));
  // Rotate the batch window — see markReaperVisited for why every examined row
  // is stamped, including the ones this pass deliberately left alone.
  await markReaperVisited(
    rows.map((r) => r.sandboxId),
    now,
  );
  if (result.deferred > 0) {
    console.log('[reaper] batch saturated — remaining rows rotate to the next pass', {
      matching: result.matching,
      examined: result.candidates,
      deferred: result.deferred,
    });
  }
  return result;
}
