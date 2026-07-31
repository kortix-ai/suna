/**
 * THE COMPUTE BILLING INVARIANT
 *
 *   `no compute row may stay open unless its sandbox is PROVABLY alive`
 *
 * Closing the meter used to be the responsibility of every individual stop path
 * — the reaper idle-stop, the reaper reconcile, the provider webhook, the
 * explicit user stop, session end/delete, the in-place restart, hibernate, the
 * error/teardown path, account deletion. Every one of them calls
 * `pauseComputeSession(...).catch(warn)` and then flips the sandbox row anyway,
 * so ONE transient failure at pause time strands that billing row forever, and
 * one caller passing the wrong id (session-lifecycle/actions.ts passed a
 * sessionId where a sandboxId was required) strands every row it touches.
 * Nothing ever re-checked. Measured live 2026-07-29: 17 open, still-accruing
 * compute rows whose own `session_sandboxes` row already said `stopped`/`error`
 * — 5,587 sandbox-hours, the worst two at 829h (34.5 days) each.
 *
 * The N-caller design is why this class of bug keeps regressing (2026-06-21,
 * 2026-07-07/#4228, 2026-07-29). So the fast paths stay as an optimisation, but
 * correctness rests on the two mechanisms here and in
 * billing/services/compute-liveness.ts, neither of which asks any caller to
 * remember anything:
 *
 *   1. SETTLEMENT IS EVIDENCE-BOUNDED. A window can never bill past the last
 *      control-plane observation of liveness plus the provider's own auto-stop
 *      ceiling, so a stranded row simply stops accruing on its own.
 *   2. THE SWEEP (compute-invariant-sweep.ts) re-derives, from scratch every
 *      pass, whether each open row still has a provably-alive sandbox, and
 *      closes the ones that do not.
 *
 * Adding a tenth `pauseComputeSession` call site is not how this gets fixed.
 *
 * This module is the PURE half: what to close, and how far to bill it. No `db`,
 * no provider adapters, so the money semantics are exhaustively unit-testable.
 */

import type { SandboxStatus } from '../../platform/providers/status';
import { billableWindowEnd } from './compute-liveness';

export type ComputeCloseReason =
  | 'sandbox-row-missing'
  | 'sandbox-not-active'
  | 'runtime-start-failed'
  | 'beyond-liveness-ceiling'
  | 'provider-not-running'
  | 'unresolvable-past-ceiling'
  | 'window-past-max';

export interface ComputeCloseDecision {
  reason: ComputeCloseReason | null;
  /** Which of the provider round-trips this decision needed. DB-only rules
   *  resolve to false so the common leak costs zero provider calls. */
  needsProviderStatus: boolean;
}

/**
 * The single authority on whether an open compute window must be closed.
 *
 * Rule order is deliberate: every DB-only rule is evaluated FIRST, so the
 * dominant real-world leak (a sandbox row we already marked stopped) is caught
 * without a provider round-trip — which matters because in live prod 44 of 66
 * open rows answered `unknown` from the provider, i.e. `unknown` is the steady
 * state for a box that has been deleted out from under us, not a transient.
 *
 * `unknown` may justify not KILLING a box (we might fight a wake). It can never
 * justify continuing to CHARGE for one, so an unresolvable box stops billing
 * once it has been continuously unresolvable past the ceiling. And no window may
 * exceed `maxWindowMs` under any circumstances — that is the rule that makes a
 * 829-hour row impossible regardless of what anything else claims.
 *
 * Pure so the money semantics are exhaustively unit-tested.
 */
export function decideComputeClose(input: {
  sandboxStatus: string | null;
  hasProviderTarget: boolean;
  runtimeStartFailed: boolean;
  providerStatus: SandboxStatus | null;
  unresolvedForMs: number | null;
  openForMs: number;
  beyondLivenessCeiling: boolean;
  unresolvedCeilingMs: number;
  maxWindowMs: number;
}): ComputeCloseDecision {
  const db_ = (reason: ComputeCloseReason | null): ComputeCloseDecision => ({
    reason,
    needsProviderStatus: false,
  });
  // ── DB-only rules (no provider call) ──
  if (!input.sandboxStatus || !input.hasProviderTarget) return db_('sandbox-row-missing');
  if (input.sandboxStatus !== 'active' && input.sandboxStatus !== 'provisioning') {
    return db_('sandbox-not-active');
  }
  // The wake/provision never produced a running box: the meter was opened
  // optimistically by startComputeSession and the failure path left it open.
  // Billing a box that demonstrably failed to start is never correct.
  if (input.runtimeStartFailed) return db_('runtime-start-failed');
  // Past the evidence ceiling the window can never bill another second (the
  // clamp in settleComputeWindow already guarantees that), so the row is dead
  // weight — close it rather than re-examining it every pass forever.
  if (input.beyondLivenessCeiling) return db_('beyond-liveness-ceiling');
  if (input.openForMs >= input.maxWindowMs) return db_('window-past-max');

  // ── Provider-informed rules ──
  if (
    input.providerStatus === 'stopped' ||
    input.providerStatus === 'removed' ||
    input.providerStatus === 'terminal'
  ) {
    return { reason: 'provider-not-running', needsProviderStatus: true };
  }
  if (
    input.providerStatus !== 'running' &&
    input.unresolvedForMs !== null &&
    input.unresolvedForMs >= input.unresolvedCeilingMs
  ) {
    return { reason: 'unresolvable-past-ceiling', needsProviderStatus: true };
  }
  return { reason: null, needsProviderStatus: true };
}

/**
 * A wake/start that demonstrably failed. `resumeStoppedSandbox` stamps
 * `runtimeWakeStartedAt` before kicking the provider and `runtimeWakeFailedAt`
 * + `runtimeWakeError` when that start throws; a later successful wake clears
 * both. A failure stamp that is not older than the wake it belongs to means the
 * box never came up — observed in prod with the meter still accruing behind it.
 */
export function hasFailedRuntimeStart(metadata: Record<string, unknown> | null): boolean {
  const failedAt = typeof metadata?.runtimeWakeFailedAt === 'string' ? Date.parse(metadata.runtimeWakeFailedAt) : Number.NaN;
  if (!Number.isFinite(failedAt)) return false;
  const startedAt = typeof metadata?.runtimeWakeStartedAt === 'string' ? Date.parse(metadata.runtimeWakeStartedAt) : Number.NaN;
  return !Number.isFinite(startedAt) || failedAt >= startedAt;
}

/**
 * When the final billed window should END for each close reason — "bill only
 * time we can affirmatively evidence the box was alive" rather than wall-clock
 * up to whenever we happened to notice. `settleComputeWindow` clamps a window
 * end at/behind `last_billed_at` to a zero-cost settle, so an already-debited
 * amount is never re-charged and never auto-refunded (refunds stay a human
 * decision — see scripts/reimburse-compute-leak.ts).
 */
export function computeCloseWindowEnd(input: {
  reason: ComputeCloseReason;
  now: Date;
  startedAt: Date;
  sandboxUpdatedAt: Date | null;
  unresolvedSince: Date | null;
  runtimeWakeFailedAt: Date | null;
  lastAliveAt: Date;
  livenessGraceMs: number;
  maxWindowMs: number;
}): Date {
  const clamp = (d: Date | null): Date => {
    if (!d || Number.isNaN(d.getTime())) return input.now;
    if (d.getTime() < input.startedAt.getTime()) return input.startedAt;
    return d.getTime() > input.now.getTime() ? input.now : d;
  };
  const byReason = (): Date => {
    switch (input.reason) {
      // We recorded the stop when we flipped the sandbox row — bill to then, not
      // to the 34 days later that we noticed.
      case 'sandbox-not-active':
        return clamp(input.sandboxUpdatedAt);
      case 'runtime-start-failed':
        return clamp(input.runtimeWakeFailedAt);
      // The last moment the box was affirmatively resolvable.
      case 'unresolvable-past-ceiling':
        return clamp(input.unresolvedSince);
      case 'window-past-max':
        return clamp(new Date(input.startedAt.getTime() + input.maxWindowMs));
      default:
        return input.now;
    }
  };
  // Whatever the reason argues for, the evidence ceiling always wins: a box
  // cannot outlive its last observed liveness by more than the provider's own
  // auto-stop. This makes the close reason an optimisation rather than a
  // correctness requirement — get the reason wrong and the bill is still capped.
  return clamp(
    billableWindowEnd({
      requestedEnd: byReason(),
      lastAliveAt: input.lastAliveAt,
      graceMs: input.livenessGraceMs,
    }),
  );
}
