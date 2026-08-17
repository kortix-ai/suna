/**
 * Provider-agnostic sandbox reaper + state/billing reconciler.
 *
 * ONE RULE for running boxes: `deadline_at <= now()` → stop it.
 *
 * `session_sandboxes.deadline_at` is the idle expiry clock. A separate durable
 * `metadata.activeTurns` records are created by accepted control-plane prompt
 * delivery. This pass renews the clock while any record is active. Terminal
 * sandbox evidence can only remove the record and pull the deadline IN. A turn
 * record renews the deadline only after the reaper observes that exact OpenCode
 * turn in flight.
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
import { type SandboxProvider, type SandboxStatus, getProvider } from '../../platform/providers';
import { invalidateProviderCache } from '../../sandbox-proxy';
import { REAP_CONCURRENCY } from '../reaper-constants';
import { preserveEstablishedRuntime } from '../runtime-identity';
import { runtimeWakeInProgress } from '../session-lifecycle/runtime-wake-fence';
import {
  type SandboxTurnDeliveryReconciliation,
  type SandboxTurnObservation,
  clearSandboxTurn,
  reconcileSandboxTurnDelivery,
  renewActiveSandboxTurn,
  storedSandboxTurns,
} from '../sandbox-turn-lifecycle';
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
  lifecycleRenewed: number; // provider-native timer renewed for a live Kortix deadline
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
  lifecycleRenewed: 0,
  errors: 0,
};

export interface SandboxReaperDependencies {
  renewActiveSandboxTurn: typeof renewActiveSandboxTurn;
  observeSandboxTurn: typeof observeSandboxTurn;
  reconcileSandboxTurnDelivery: typeof reconcileSandboxTurnDelivery;
  clearSandboxTurn: typeof clearSandboxTurn;
}

const DEFAULT_REAPER_DEPENDENCIES: SandboxReaperDependencies = {
  renewActiveSandboxTurn,
  observeSandboxTurn,
  reconcileSandboxTurnDelivery,
  clearSandboxTurn,
};

export interface SandboxReaperScope {
  /** Optional operational/test scope. Production maintenance omits it. */
  sandboxIds?: readonly string[];
  /** Fast lifecycle lane. Excludes every row without durable turn authority. */
  activeTurnsOnly?: boolean;
}

/**
 * One reaper pass over active session sandboxes. For each:
 *   - ask the provider its REAL state,
 *   - reconcile our row + close billing if it is not running,
 *   - otherwise stop it iff its deadline has passed.
 * Bounded concurrency so a batch of provider round-trips doesn't serialize.
 */
export async function reapAndReconcileSandboxes(
  now = new Date(),
  dependencyOverrides: Partial<SandboxReaperDependencies> = {},
  scope?: SandboxReaperScope,
): Promise<ReapResult> {
  const dependencies = { ...DEFAULT_REAPER_DEPENDENCIES, ...dependencyOverrides };
  const activeTurnsOnly = scope?.activeTurnsOnly === true;
  const candidatePredicate = reapCandidatePredicate(scope?.sandboxIds, activeTurnsOnly);
  const rows = await selectReapCandidates(candidatePredicate, activeTurnsOnly);

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
        const provider = getProvider(row.provider);
        const providerStatus: SandboxStatus = await provider.getStatus(row.externalId);

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
          // Close the only non-atomic gap in the contract. The API writes a
          // token-bound `delivering` record before the request can reach
          // OpenCode. If OpenCode accepts it and the promotion write then fails,
          // this provider-neutral probe repairs the same record. The sandbox
          // cannot create a record or select its token.
          const turns = storedSandboxTurns(row.metadata);
          const observedActiveTokens: string[] = [];
          if (turns.length > 0) {
            for (const turn of turns) {
              // A delivering record can precede OpenCode persistence by a few
              // seconds. Observe it only after its delivery grace expires.
              // An accepted active record is safe to observe on every pass.
              // This repairs a terminal relay that cannot reach the API while
              // the API can still reach the daemon.
              if (turn.state === 'delivering' && row.deadlineAt.getTime() > now.getTime()) {
                continue;
              }
              const observation = await dependencies.observeSandboxTurn(
                provider,
                row.externalId,
                row.sandboxId,
                turn,
              );
              if (turn.state === 'delivering') {
                const reconciliation = await dependencies.reconcileSandboxTurnDelivery(
                  row.sandboxId,
                  turn.token,
                  observation,
                );
                if (reconciliation === 'active') {
                  observedActiveTokens.push(turn.token);
                } else if (
                  reconciliation === 'deferred' &&
                  row.deadlineAt.getTime() <= now.getTime()
                ) {
                  // Unknown OpenCode state cannot renew itself forever. The
                  // original delivery grace has expired, so remove only this
                  // token. A concurrent prompt has a different token and the
                  // final stop claim will refuse to race it.
                  await dependencies.clearSandboxTurn(row.sandboxId, turn.token);
                }
              } else if (observation === 'active') {
                observedActiveTokens.push(turn.token);
              } else if (observation === 'terminal') {
                await dependencies.clearSandboxTurn(row.sandboxId, turn.token);
              } else if (row.deadlineAt.getTime() <= now.getTime()) {
                await dependencies.clearSandboxTurn(row.sandboxId, turn.token);
              }
            }
          }

          // Refresh the idle deadline only from fresh evidence for the exact
          // token observed above. A stale record or unreadable daemon cannot
          // renew itself. This keeps long local tool calls alive without
          // restoring the old sandbox-authored execution lease.
          let activeTurnRenewed = false;
          for (const token of observedActiveTokens) {
            if ((await dependencies.renewActiveSandboxTurn(row.sandboxId, token)) === 'renewed') {
              activeTurnRenewed = true;
              break;
            }
          }
          if (activeTurnRenewed) {
            await provider.renewLifecycle(row.externalId);
            result.lifecycleRenewed += 1;
            result.skipped += 1;
            continue;
          }
          // THE ONE RULE. `deadline_at` is pushed out only by a
          // control-plane-OBSERVED turn start and pulled in by a
          // sandbox-reported turn end, so this comparison is the whole
          // decision — no probe, no lease, no activity clock, no ceiling
          // arithmetic, and nothing the box itself can influence upward.
          if (row.deadlineAt.getTime() > now.getTime()) {
            // Keep the PROVIDER'S own timer subordinate to Kortix's deadline.
            // E2B has an absolute one-hour timeout; Daytona and Platinum have
            // native idle timers. Without this provider-neutral renewal, any
            // one of them can stop a box while the Kortix deadline still says a
            // live agent turn owns it. The sandbox cannot call this method.
            await provider.renewLifecycle(row.externalId);
            result.lifecycleRenewed += 1;
            result.skipped += 1;
            continue;
          }
          // `row.deadlineAt` and `now` are BOTH from before this row's provider
          // round-trip, so this decision is provisional: stopExpiredBox re-reads
          // the deadline against a fresh clock immediately before issuing the
          // stop, and returns 'skipped' if a prompt arrived in the meantime.
          const outcome = await stopExpiredBox(row, now, 'deadline_expired');
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
            if (providerStatus === 'stopped' && runtimeWakeInProgress(row.metadata, now)) {
              result.skipped += 1;
              break;
            }
            await applyStoppedState({
              sandboxId: row.sandboxId,
              sessionId: row.sessionId,
              externalId: row.externalId,
              stopReason: 'provider_reconcile',
              now,
            });
            result.reconciled += 1;
            result.billingClosed += 1;
            break;
          case 'reconcile-removed':
            // A provider 404 can be a transient archive/restore observation.
            // Preserve the established identity; never turn this signal into a
            // fresh, empty sandbox for the same session.
            await preserveEstablishedRuntime(
              row,
              'provider_reported_removed',
              'provider_removed',
              now,
            );
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

/**
 * Observe only a control-plane-minted `delivering` record through the common
 * daemon health contract. The provider adapter resolves transport and auth.
 */
export async function observeSandboxTurn(
  provider: Pick<SandboxProvider, 'resolveEndpoint'>,
  externalId: string,
  _sandboxId?: string,
  identity?: { token?: string; opencodeSessionId: string; messageId: string | null },
): Promise<SandboxTurnObservation> {
  try {
    const endpoint = await provider.resolveEndpoint(externalId);
    const url = new URL(`${endpoint.url.replace(/\/$/, '')}/kortix/health`);
    url.searchParams.set('turn', '1');
    if (identity?.opencodeSessionId) {
      url.searchParams.set('turn_session_id', identity.opencodeSessionId);
    }
    if (identity?.messageId) {
      url.searchParams.set('turn_message_id', identity.messageId);
    }
    const response = await fetch(url, {
      headers: endpoint.headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return 'unknown';
    const body = (await response.json()) as { turn_in_flight?: unknown };
    if (body.turn_in_flight === true) return 'active';
    if (body.turn_in_flight === false) return 'terminal';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
