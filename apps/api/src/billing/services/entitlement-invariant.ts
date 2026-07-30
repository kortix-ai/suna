/**
 * The invariant that makes monthly entitlement checkable instead of discovered.
 *
 * WHY THIS EXISTS. Monthly allowance drift was found by hand, months late, after
 * it had reached tens of thousands of dollars across ~1,600 accounts. The
 * balances were then reconciled by hand. A hand-run reconciliation is not a fix:
 * it corrects the symptom once and leaves the next drift equally invisible.
 *
 * So this module states, as a pure function, what a tier's EXPIRING credit is
 * allowed to be — and `expiringCreditExceedsEntitlement` reports the accounts
 * that break it. It deliberately does NOT move money. An automatic corrector
 * that silently adjusted customer balances would be a worse version of the same
 * problem: an unreviewed process mutating wallets on a rule nobody is watching.
 *
 * WHY THE EXPIRING BUCKET SPECIFICALLY. `expiring_credits` is the monthly
 * allowance, and only three things write it: the monthly reset (which SETS it to
 * exactly the tier allowance), the activation grant, and the per-seat delta
 * grant. Its ceiling is therefore knowable — it can never legitimately exceed
 * one cycle's allowance. `non_expiring_credits` has no such ceiling: purchases,
 * machine bonuses and reservation refunds all land there legitimately, so a
 * check against total balance would be permanently noisy and get ignored. This
 * check would have flagged the $40-instead-of-$25 per-seat grant on the very
 * first seat addition.
 */

import { getTier, grantForSeats, isPerSeatAccount } from './tiers';

/**
 * Dollars of slack before a breach is reported. Covers the 4-decimal precise
 * columns, the legacy 2-decimal mirror, and a fractional refund landing back in
 * the expiring bucket — while still catching any real grant-sizing bug, whose
 * smallest possible error is a whole tier increment.
 */
export const ENTITLEMENT_DRIFT_TOLERANCE_USD = 0.5;

export interface EntitlementSubject {
  tier?: string | null;
  billingModel?: string | null;
  seatCount?: number | null;
}

export interface EntitlementBreach {
  expectedUsd: number;
  actualUsd: number;
  excessUsd: number;
}

/**
 * The expiring-credit allowance one billing cycle may grant this account.
 *
 * per-seat: $25 x seats (INCLUDED_CREDITS_PER_SEAT_USD, never the $40 price).
 * free: $2. pro: $0 by design — its $5 is a one-time non-expiring machine bonus,
 * not a monthly allowance. legacy tier_N_M: the tier's monthlyCredits, 1:1 with
 * the price the customer pays.
 */
export function expectedMonthlyEntitlementUsd(subject: EntitlementSubject): number {
  const tierName = subject.tier ?? 'none';

  // Keyed off billing_model OR tier, because a per-seat account can carry either
  // marker: `tier` is set to 'per_seat' by the webhook, and `billing_model`
  // survives independently. Sizing a per-seat team off the flat tier allowance is
  // exactly the bug that granted a 6-seat team $25 instead of $150.
  if (isPerSeatAccount(subject.billingModel) || tierName === 'per_seat') {
    return grantForSeats(Math.max(1, subject.seatCount ?? 1));
  }

  return getTier(tierName).monthlyCredits;
}

/**
 * Whether this account's expiring credit materially exceeds what any single
 * cycle is allowed to grant it. Returns the breach, or null when the account is
 * within tolerance.
 */
export function expiringCreditExceedsEntitlement(
  subject: EntitlementSubject & { expiringCredits?: unknown },
): EntitlementBreach | null {
  const expectedUsd = expectedMonthlyEntitlementUsd(subject);
  const actualUsd = Number(subject.expiringCredits ?? 0) || 0;
  const excessUsd = actualUsd - expectedUsd;

  if (excessUsd <= ENTITLEMENT_DRIFT_TOLERANCE_USD) return null;
  return { expectedUsd, actualUsd, excessUsd };
}

/**
 * A negative expiring balance is its own defect: the debit RPCs refuse to
 * overdraw, so it can only come from an unguarded write (the admin debit route
 * grants a negative amount through `atomic_add_credits`, which has no sign
 * check) or from the reset preserving a negative bucket.
 */
export function expiringCreditIsNegative(subject: { expiringCredits?: unknown }): boolean {
  return (Number(subject.expiringCredits ?? 0) || 0) < 0;
}
