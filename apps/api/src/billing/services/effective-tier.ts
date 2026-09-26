// Admin-issued trial statuses (`credit_accounts.trial_status`).
//
// A trial is an OVERLAY, never a tier write: `credit_accounts.tier` belongs to
// the Stripe webhook reconciliation, which overwrites it on every subscription
// event. The trial lives in its own columns, and `resolve-billing.ts` applies
// it (and the per-seat self-heal) when it resolves the plan an account behaves
// as.

export const TRIAL_STATUS = {
  NONE: 'none',
  ACTIVE: 'active',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  /** Trial ended because the account converted to a real subscription. */
  CONVERTED: 'converted',
} as const;
