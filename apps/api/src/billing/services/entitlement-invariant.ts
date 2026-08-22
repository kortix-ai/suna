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

import {
  COMPUTE_TIERS,
  INCLUDED_CREDITS_RATIO,
  getTier,
  grantForSeats,
  isPaidTier,
  isPerSeatAccount,
} from './tiers';

/**
 * Dollars of slack before a breach is reported. Covers the 4-decimal precise
 * columns, the legacy 2-decimal mirror, and a fractional refund landing back in
 * the expiring bucket — while still catching any real grant-sizing bug, whose
 * smallest possible error is a whole tier increment.
 */
export const ENTITLEMENT_DRIFT_TOLERANCE_USD = 0.5;

/**
 * Legitimate headroom above the allowance, on top of the numeric tolerance.
 *
 * The subscription-activation grant is ADDITIVE (`grantCredits(…, isExpiring =
 * true)` in webhooks.ts), not a reset, so it stacks on whatever remains of the
 * free tier's $2 expiring welcome grant. Every customer who subscribes before
 * spending that $2 therefore, correctly, holds `allowance + 2` of expiring
 * credit for the rest of their first cycle. Without this the check is red for
 * every new paying customer on day one — and a guard that is red by
 * construction gets ignored, which is the only way this one can fail.
 *
 * This does not blunt it: the smallest REAL grant-sizing error is a whole tier
 * increment. The $40-instead-of-$25 per-seat bug is $15 on a single seat, still
 * an order of magnitude clear of this headroom.
 */
const FIRST_CYCLE_FREE_GRANT_HEADROOM_USD = 2;

/** Total excess, in dollars, that is reported as a breach on a PAID tier. */
export const ENTITLEMENT_BREACH_THRESHOLD_USD =
  ENTITLEMENT_DRIFT_TOLERANCE_USD + FIRST_CYCLE_FREE_GRANT_HEADROOM_USD;

/**
 * The headroom only exists for an account that carried the free grant INTO a
 * paid tier. A free account has nothing to carry, so it keeps the tight
 * tolerance — otherwise a free wallet double-granted to $4 (the exact risk if
 * either of the two systems that reset the free tier is ever changed to an
 * additive grant, at 148k-account scale) would fall inside the headroom and go
 * unreported.
 */
function breachThresholdUsd(tierName: string): number {
  return tierName === 'free' ? ENTITLEMENT_DRIFT_TOLERANCE_USD : ENTITLEMENT_BREACH_THRESHOLD_USD;
}

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
 * free: $2. legacy tier_N_M: the tier's monthlyCredits, 1:1 with the price the
 * customer pays.
 *
 * A PAID tier whose catalog grant is 0 (legacy `pro`) is the interesting case,
 * and it changed. It used to be 0 "by design" — and that was the bug: those
 * customers paid every month and their renewal granted nothing, which is what
 * PR #6662 fixed. A renewal now grants `amount_paid x INCLUDED_CREDITS_RATIO`
 * (see `resolveRenewalGrant`), so an expectation of 0 makes every one of them a
 * permanent false breach — and this check exits non-zero, so a guard that is red
 * by construction gets ignored, which is the only way this one can fail.
 *
 * The row alone cannot say what the customer actually paid, so the expectation
 * is the CEILING a single legitimate cycle can reach: the dearest machine we
 * sell, at the included-credits ratio. That keeps the check meaningful — a
 * grant-sizing error still has to clear the most expensive real plan to hide —
 * while no longer flagging correctly-granted accounts.
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

  const tier = getTier(tierName);
  // `getTier` falls back to `none` for anything it does not know, so an unknown
  // or garbage tier reaches here looking exactly like a zero-grant paid tier.
  // Requiring the name to round-trip keeps the ceiling below FAIL-CLOSED: a tier
  // nobody has heard of gets an allowance of 0 and stays visible to the audit,
  // rather than quietly inheriting the most generous plan we sell.
  const isKnownTier = tier.name === tierName;
  if (isKnownTier && tier.monthlyCredits === 0 && isPaidTier(tierName)) {
    return maxAmountBasedCycleGrantUsd();
  }
  return tier.monthlyCredits;
}

/**
 * The largest grant one amount-based renewal can legitimately produce: the
 * priciest machine in the catalog at the included-credits ratio. Derived, not
 * typed as a literal, so adding a dearer compute tier cannot silently turn a
 * real over-grant into an accepted one.
 */
function maxAmountBasedCycleGrantUsd(): number {
  const dearest = Math.max(...Object.values(COMPUTE_TIERS).map((t) => t.priceUsd));
  return Math.round(dearest * INCLUDED_CREDITS_RATIO * 100) / 100;
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

  if (excessUsd <= breachThresholdUsd(subject.tier ?? 'none')) return null;
  return { expectedUsd, actualUsd, excessUsd };
}

/**
 * A negative expiring balance is its own defect: the debit RPC refuses to
 * overdraw, so it can only come from an unguarded write. The reachable vector is
 * the Drizzle fallback in credits.ts, which does an unlocked
 * `expiringCredits + amount` with no floor whenever the grant RPC errors — a
 * negative-amount expiring grant (admin tooling) lands straight in the bucket.
 *
 * Note what this does NOT cover: `non_expiring_credits` going negative, which is
 * the condition actually measured in production and is preserved forever by the
 * monthly reset. Bucket-aware refunds and a negative-non-expiring check belong
 * to the same follow-up.
 */
export function expiringCreditIsNegative(subject: { expiringCredits?: unknown }): boolean {
  return (Number(subject.expiringCredits ?? 0) || 0) < 0;
}
