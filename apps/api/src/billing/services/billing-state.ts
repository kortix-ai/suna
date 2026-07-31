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
 * service any more. Used for the factual "does this account still have a
 * subscription that exists and hasn't been terminated" question — NOT for
 * deciding who may spend without a wallet floor (see
 * PAYING_SUBSCRIPTION_STATUSES).
 */
const DEAD_SUBSCRIPTION_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

/**
 * Statuses where Stripe is actually collecting money, and therefore the ONLY
 * ones that let a per-seat account skip the wallet floor.
 *
 * This set is deliberately an ALLOW-list. It used to be the inverse — anything
 * not in DEAD_SUBSCRIPTION_STATUSES bypassed the floor — and a deny-list in the
 * spend path fails open: `past_due` and `incomplete` were never added to it, so
 * subscriptions that had stopped paying kept spending with no floor at all and
 * ran arbitrarily far negative (measured on production: dozens of accounts
 * below zero, worst past -$600). An allow-list fails CLOSED: a Stripe status
 * nobody has thought about yet gets the wallet floor rather than a blank cheque.
 *
 * `trialing` is included on purpose — a trial is a live, non-delinquent
 * subscription and is supposed to work.
 *
 * A `past_due` account is NOT cut off by this: Stripe retries for days, and
 * such an account keeps running for as long as its wallet has credit. It is
 * simply metered against that wallet like everyone else instead of spending
 * without limit. Only once the wallet is empty does it block — and then as
 * `payment_failed` ("update your card"), never as `no_subscription`
 * ("subscribe to a plan"), which is the mislabel PR #5141 fixed.
 */
const PAYING_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing']);

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

/**
 * Whether the subscription exists and has not been terminated. This is a
 * REPORTING predicate (it backs `account_state.has_active_subscription`), not a
 * spending permission — `past_due` is "live" here. Use
 * `subscriptionBypassesWalletFloor` for anything that decides who may spend.
 */
export function hasLiveSubscription(snapshot: BillingSnapshot): boolean {
  if (!snapshot.subscriptionId) return false;
  const status = snapshot.subscriptionStatus ?? '';
  return !DEAD_SUBSCRIPTION_STATUSES.has(status);
}

/** Whether Stripe is currently successfully collecting for this subscription. */
export function hasPayingSubscription(snapshot: BillingSnapshot): boolean {
  if (!snapshot.subscriptionId) return false;
  return PAYING_SUBSCRIPTION_STATUSES.has(snapshot.subscriptionStatus ?? '');
}

/**
 * THE single answer to "may this account spend without a wallet floor?".
 *
 * Both `resolveBillingState` (the read model) and the billing gate (the write
 * path that takes the admission hold) call this — they cannot diverge on who is
 * exempt from the floor, which is the whole reason this module exists. The gate
 * previously asked `isPerSeatAccount && hasLiveSubscription` on its own; that
 * second, subtly different answer is what let non-paying subscriptions spend.
 */
export function subscriptionBypassesWalletFloor(snapshot: BillingSnapshot): boolean {
  return isPerSeatAccount(snapshot.billingModel) && hasPayingSubscription(snapshot);
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
 * The account's billing state. Ordering matters: a PAYING per-seat
 * subscription short-circuits BEFORE the wallet floor, because a seat
 * subscription is not wallet-gated — that is exactly the case
 * (`per_seat` + `active` + $0.0099) that used to render "Subscribe to
 * start sessions" while the account was paying $40/mo.
 *
 * A per-seat subscription that is NOT paying falls through to the same wallet
 * floor as everyone else, and then to `payment_failed` — it keeps running on
 * whatever credit it has, and asks for a card update once that runs out.
 */
export function resolveBillingState(snapshot: BillingSnapshot): BillingState {
  if (!snapshot.exists) return 'no_account';
  if (subscriptionBypassesWalletFloor(snapshot)) return 'active';
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
