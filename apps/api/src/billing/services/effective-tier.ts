// Effective-tier resolution: the tier an account BEHAVES as, which is not the
// stored `credit_accounts.tier`.
//
// Two overlays apply, in order:
//
//   1. Admin-issued trial. A trial is an OVERLAY, never a tier write —
//      `credit_accounts.tier` belongs to the Stripe webhook reconciliation
//      (webhooks.ts syncSubscriptionState), which overwrites it on every
//      subscription event, so a trial encoded there would be clobbered. The
//      trial lives in its own columns (`trial_status`, `trial_tier`,
//      `trial_seats`, `trial_started_at`, `trial_ends_at`). Expiry is LAZY:
//      `trialIsActive` checks the wall clock, so an expired trial stops
//      granting the instant `trial_ends_at` passes — correctness never waits
//      on a cron. The billing cron sweep only flips `trial_status` to
//      'expired' afterward so the row reads honestly.
//
//   2. Per-seat self-heal. Paying per-seat accounts can carry a stale
//      tier='free' (the seat-billing migration set billing_model without
//      backfilling tier); an active seat subscription coerces the tier to
//      'per_seat' so stale data cannot mis-gate a paying team as free.
//
// Every consumer that derives behavior from a tier (enterprise entitlements,
// project/session limits, the managed-models gate) resolves through here so
// the overlays cannot skew between surfaces.

import { isPaidTier, isPerSeatAccount } from './tier-facts';
import { isValidTier } from './tiers';

export const TRIAL_STATUS = {
  NONE: 'none',
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  /** Trial ended because the account converted to a real subscription. */
  CONVERTED: 'converted',
} as const;

export type TrialStatus = (typeof TRIAL_STATUS)[keyof typeof TRIAL_STATUS];

export type TrialFields = {
  trialStatus?: string | null;
  trialTier?: string | null;
  trialSeats?: number | null;
  trialStartedAt?: string | null;
  trialEndsAt?: string | null;
};

export type SubscriptionFields = {
  billingModel?: string | null;
  stripeSubscriptionId?: string | null;
  stripeSubscriptionStatus?: string | null;
};

/** Whether the row carries a currently-granting trial. */
export function trialIsActive(
  acct: TrialFields | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!acct) return false;
  if (acct.trialStatus !== TRIAL_STATUS.ACTIVE) return false;
  if (!acct.trialTier || !isValidTier(acct.trialTier)) return false;
  if (!acct.trialEndsAt) return false;
  const endsAt = new Date(acct.trialEndsAt).getTime();
  return Number.isFinite(endsAt) && endsAt > now;
}

/**
 * Per-seat self-heal on its own (no trial overlay). Exported for display
 * surfaces that must show the same number the limit layer enforces — see
 * `effectiveTierForLimits` in shared/account-limits.ts, which delegates here.
 */
export function coercePerSeatTier(
  tier: string | null | undefined,
  subscription: SubscriptionFields | null | undefined,
): string {
  const raw = tier ?? 'free';
  if (
    !isPaidTier(raw) &&
    isPerSeatAccount(subscription?.billingModel) &&
    !!subscription?.stripeSubscriptionId &&
    subscription.stripeSubscriptionStatus !== 'canceled' &&
    subscription.stripeSubscriptionStatus !== 'unpaid'
  ) {
    return 'per_seat';
  }
  return raw;
}

/**
 * The tier the account behaves as: active trial > per-seat self-heal > stored
 * tier. Fail-closed: no row → 'none' (same convention as getAccountTier).
 */
export function resolveEffectiveTier(
  acct: (TrialFields & SubscriptionFields & { tier?: string | null }) | null | undefined,
  now: number = Date.now(),
): string {
  if (!acct) return 'none';
  if (trialIsActive(acct, now)) return acct.trialTier as string;
  return coercePerSeatTier(acct.tier ?? 'none', acct);
}

/** Seat allowance while a trial is active; null when no active trial or uncapped. */
export function activeTrialSeatLimit(
  acct: TrialFields | null | undefined,
  now: number = Date.now(),
): number | null {
  if (!trialIsActive(acct, now)) return null;
  const seats = acct?.trialSeats;
  return typeof seats === 'number' && Number.isFinite(seats) && seats > 0
    ? Math.floor(seats)
    : null;
}
