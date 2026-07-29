/**
 * The ONE answer to "what is this account's billing situation?".
 *
 * Before this module the question was answered in at least four places with
 * four different rules — the billing gate (per-seat active-sub bypass + wallet
 * floor), `getCreditSummary().canRun` (bare wallet floor), the web session-page
 * gate (`!can_run` → rendered as "no plan"), and the upgrade modal (per-seat OR
 * has-subscription). A Team account on an ACTIVE $40/mo subscription whose
 * wallet had drained to $0.01 therefore got told "Your team isn't on a plan
 * yet — Subscribe to Team plan" by the session page while the modal that CTA
 * opened said "your Team plan and seats are unaffected". Both surfaces were
 * reading the same account and disagreeing.
 *
 * Everything that needs to know now derives it from `resolveBillingState`,
 * which is pure (no DB, no Stripe, no clock) and therefore exhaustively
 * testable. The states are deliberately about the ACCOUNT, not about any one
 * caller's error taxonomy:
 *
 * - `active`          — may run. Either an active per-seat subscription (which
 *                       is not wallet-gated at all) or a funded wallet.
 * - `out_of_credits`  — HAS a plan, wallet at/below the run floor. → "Top up".
 * - `no_subscription` — genuinely not on a plan. → "Subscribe".
 * - `payment_failed`  — has a plan whose payment is failing AND the wallet can't
 *                       cover the gap. → "Fix payment", never "you have no plan".
 * - `no_account`      — no credit row at all (account setup incomplete).
 *
 * Rule of thumb this module exists to enforce (the lesson from PR #5141):
 * never infer "has a subscription" from `tier_key`. `tier_key` stays `free` for
 * plenty of paying accounts, and `per_seat` stays set long after a subscription
 * is cancelled.
 */

import { MINIMUM_CREDIT_FOR_RUN, isPaidTier, isPerSeatAccount } from './tier-facts';

export type BillingState =
  | 'active'
  | 'out_of_credits'
  | 'no_subscription'
  | 'payment_failed'
  | 'no_account';

/**
 * Stripe subscription statuses that mean the subscription is NOT providing
 * service any more. Anything else (`active`, `trialing`, `past_due`, …) still
 * entitles a per-seat account to run — `past_due` in particular must keep
 * working, since Stripe retries for days before giving up and cutting a paying
 * customer off mid-dunning would be worse than the unpaid margin.
 */
const DEAD_SUBSCRIPTION_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

/** Subscription statuses that mean Stripe is failing to collect. */
const FAILING_SUBSCRIPTION_STATUSES = new Set([
  'past_due',
  'unpaid',
  'incomplete',
  'incomplete_expired',
]);

/** `credit_accounts.payment_status` values that mean Stripe is failing to collect. */
const FAILING_PAYMENT_STATUSES = new Set(['past_due', 'failed', 'payment_failed', 'unpaid']);

/**
 * The subset of a `credit_accounts` row the decision depends on. Taken as a
 * plain snapshot (not the Drizzle row) so callers on the web/SDK side and tests
 * can build one without a DB.
 */
export interface BillingSnapshot {
  /** False when there is no `credit_accounts` row for the account at all. */
  exists: boolean;
  balance: number;
  billingModel?: string | null;
  tier?: string | null;
  subscriptionId?: string | null;
  subscriptionStatus?: string | null;
  paymentStatus?: string | null;
}

/**
 * Whether a Stripe subscription status means the subscription has stopped
 * providing service. Exported so non-gate callers (auto-topup's payment-method
 * discovery) classify subscription statuses with the SAME rule as the gate.
 */
export function isDeadSubscriptionStatus(status: string | null | undefined): boolean {
  return DEAD_SUBSCRIPTION_STATUSES.has(status ?? '');
}

/** Whether a subscription row exists at all, live or lapsed. */
export function hasSubscriptionRecord(snapshot: BillingSnapshot): boolean {
  return !!snapshot.subscriptionId;
}

/** Whether the subscription is currently providing service. */
export function hasLiveSubscription(snapshot: BillingSnapshot): boolean {
  if (!snapshot.subscriptionId) return false;
  const status = snapshot.subscriptionStatus ?? '';
  return !DEAD_SUBSCRIPTION_STATUSES.has(status);
}

/**
 * "Is this account on a plan?" — the single question every surface used to
 * answer for itself. True for any account that has ever had a subscription row
 * (a lapsed Team account is a customer with a billing problem, NOT a prospect)
 * and for any paid tier. Deliberately does NOT look at `billing_model`:
 * `per_seat` is set at migration time and survives cancellation.
 */
export function hasPlan(snapshot: BillingSnapshot): boolean {
  if (!snapshot.exists) return false;
  if (hasSubscriptionRecord(snapshot)) return true;
  return isPaidTier(snapshot.tier ?? 'none');
}

/** Whether Stripe is currently failing to collect for this account. */
export function paymentIsFailing(snapshot: BillingSnapshot): boolean {
  if (FAILING_SUBSCRIPTION_STATUSES.has(snapshot.subscriptionStatus ?? '')) return true;
  return FAILING_PAYMENT_STATUSES.has(snapshot.paymentStatus ?? '');
}

/** Whether the wallet can cover the admission floor for one run. */
export function walletCoversRun(snapshot: BillingSnapshot): boolean {
  return snapshot.balance >= MINIMUM_CREDIT_FOR_RUN;
}

/**
 * The account's billing state. Ordering matters: an active per-seat
 * subscription short-circuits BEFORE the wallet floor, because a seat
 * subscription is not wallet-gated — that is exactly the case
 * (`per_seat` + `active` + $0.0099) that used to render "Subscribe to
 * start sessions" while the account was paying $40/mo.
 */
export function resolveBillingState(snapshot: BillingSnapshot): BillingState {
  if (!snapshot.exists) return 'no_account';
  if (isPerSeatAccount(snapshot.billingModel) && hasLiveSubscription(snapshot)) return 'active';
  if (walletCoversRun(snapshot)) return 'active';
  if (paymentIsFailing(snapshot)) return 'payment_failed';
  if (hasPlan(snapshot)) return 'out_of_credits';
  return 'no_subscription';
}

/** Whether a state permits starting work. The inverse of "blocked". */
export function billingStateAllowsRun(state: BillingState): boolean {
  return state === 'active';
}

/**
 * Whether the account's problem is fixed by adding credits (top-up) rather
 * than by subscribing. Drives which CTA/modal every blocked surface shows.
 */
export function billingStateNeedsTopUp(state: BillingState): boolean {
  return state === 'out_of_credits' || state === 'payment_failed';
}

/** Build a snapshot from a `credit_accounts` row (or its absence). */
export function billingSnapshotFromAccount(
  account:
    | {
        balance?: unknown;
        billingModel?: string | null;
        tier?: string | null;
        stripeSubscriptionId?: string | null;
        stripeSubscriptionStatus?: string | null;
        paymentStatus?: string | null;
      }
    | null
    | undefined,
): BillingSnapshot {
  if (!account) return { exists: false, balance: 0 };
  return {
    exists: true,
    balance: Number(account.balance ?? 0) || 0,
    billingModel: account.billingModel ?? null,
    tier: account.tier ?? null,
    subscriptionId: account.stripeSubscriptionId ?? null,
    subscriptionStatus: account.stripeSubscriptionStatus ?? null,
    paymentStatus: account.paymentStatus ?? null,
  };
}
