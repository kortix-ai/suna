/**
 * Pure reconciliation math for an atomic admission hold taken by
 * checkBillingActive (billing-gate.ts) against the real settled cost of a
 * gateway request.
 *
 * Pulled out of hooks.ts (which pulls in the DB, account-token validation,
 * gateway trace persistence, etc. at import time — the same reason
 * gateway-trace-row.ts's sanitizer was split out) so the actual dollar math
 * is directly unit-testable without standing up that whole graph.
 */
export interface HoldReconciliation {
  /** Additional amount to collect (real cost exceeded the hold). Always >= 0. */
  toDeduct: number;
  /** Amount to hand back (hold exceeded the real cost). Always >= 0. */
  toRefund: number;
}

export function reconcileBillingHold(finalCost: number, holdUsd: number): HoldReconciliation {
  const remainder = finalCost - holdUsd;
  if (remainder > 0) return { toDeduct: remainder, toRefund: 0 };
  if (remainder < 0) return { toDeduct: 0, toRefund: -remainder };
  return { toDeduct: 0, toRefund: 0 };
}

/**
 * True for the synthetic zero-usage, zero-cost event handler.ts emits when a
 * pre-dispatch failure must refund an admission hold that was never spent
 * (see handler.ts's refundBillingHold). Recognized so recordGatewayUsage can
 * skip the usage_events observability write entirely for it — it carries no
 * real provider/model/token data, so writing it would just be zero-value
 * noise on every pre-dispatch failure (oversized body, no candidates, ...).
 */
export function isPureHoldRefund(event: {
  billingHoldUsd?: number;
  promptTokens: number;
  completionTokens: number;
  finalCost: number;
}): boolean {
  return (
    event.billingHoldUsd != null &&
    event.promptTokens === 0 &&
    event.completionTokens === 0 &&
    event.finalCost === 0
  );
}
