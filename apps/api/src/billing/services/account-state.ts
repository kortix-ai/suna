import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';
import { config } from '../../config';
import { isPlatformAdmin } from '../../shared/platform-roles';
import type { AccountStateResponse, CommitmentInfo, ScheduledChange } from '../../types';
import { getCreditAccount } from '../repositories/credit-accounts';
import { getAutoTopupSettings } from './auto-topup';
import { resolveAccountBilling } from './billing-cache';
import { enterpriseEntitledFromRow } from './resolve-billing';
import {
  billingSnapshotFromAccount,
  billingStateAllowsRun,
  hasLiveSubscription,
  resolveBillingState,
} from './billing-state';
import { getCreditSummary } from './credits';
import { initializeFreeTierAccount } from './free-tier';
import { PLAN_CATALOG, PLAN_FAMILY_LABELS } from './plan-catalog';
import { canonicalTier, getTier, getTierEntitlements, planMonthlyUsd } from './tiers';
import { getAccountEntitlements } from './entitlements';
import { currentPeriodStart, getUsageBreakdownThisPeriod } from './usage-breakdown';

type CreditAccountRow = Awaited<ReturnType<typeof getCreditAccount>>;

export async function buildMinimalAccountState(accountId: string): Promise<AccountStateResponse> {
  // Single source of truth for the credit_accounts row for this request.
  // getCreditSummary / getAccountEntitlements / getAutoTopupSettings used to
  // each independently re-fetch this identical row — now they take it as a
  // param, cutting 4 reads of the same row down to 1. Request-scoped only, not
  // cached across requests: this endpoint gates real spending, so it must
  // always read the live balance.
  let account = await getCreditAccount(accountId);
  // The $2 welcome grant is a WALLET write — a charging action. It must stay
  // behind the same charging gate as every debit, or a billing-disabled
  // deployment (self-hosted, dev) mints free_tier_grant ledger rows on every
  // billing-state read of a row-less account (KRTX-1832). With charging off
  // the row stays absent and the response falls through to the free defaults.
  if (!account && config.KORTIX_BILLING_INTERNAL_ENABLED) {
    await initializeFreeTierAccount(accountId);
    account = await getCreditAccount(accountId);
  }
  const sub = account;

  // STORED tier — the plan Stripe sold, legacy keys folded into `credits`. It
  // stays the wire value of `subscription.tier_key` and drives everything
  // Stripe-owned below (subscription status, the monthly amount).
  const tierName = sub ? canonicalTier(sub.tier ?? 'free') : 'none';
  const tier = getTier(tierName);
  const monthlyUsd = tierName === 'credits' && sub ? planMonthlyUsd(sub) : null;

  // RESOLVED plan — the plan the account BEHAVES as: active admin trial >
  // stored tier, with the enterprise and managed-models
  // overrides applied (billing/services/resolve-billing.ts). `sub` is passed in
  // so this costs no extra read; the request already holds the row.
  //
  // The two used to be conflated: a trialing account's account-state described
  // its STORED plan while every gate enforced the TRIAL plan, so the dashboard
  // disagreed with the server about what the account could do. `plan` and
  // `tier` below now report the resolved view; `subscription` keeps the stored
  // one for wire compatibility.
  // Started here, awaited with the reads below: none of them needs it.
  const resolvedPending = resolveAccountBilling(accountId, { row: sub });

  // All of these are independent of one another (each keyed only on accountId
  // and/or the `account` row already fetched above) — run them concurrently
  // instead of ~8 sequential round-trips.
  const [resolved, [credits, isAdmin, entitlements, autoTopup, usageThisPeriod]] =
    await Promise.all([resolvedPending, Promise.all([
      getCreditSummary(account),
      isPlatformAdmin(accountId),
      // Entitlements must honor the self-serve enterprise DEMO flag, not just the
      // billing tier — otherwise flipping the demo on never surfaces the SSO/SCIM
      // cards (the tier's static entitlements say sso:false). getAccountEntitlements
      // applies the demo override.
      getAccountEntitlements(accountId, account),
      getAutoTopupSettings(accountId, account),
      sub
        ? getUsageBreakdownThisPeriod(accountId, currentPeriodStart(sub.billingCycleAnchor ?? null)).catch(() => null)
        : Promise.resolve(null),
    ])]);

  const isCancelled =
    sub?.stripeSubscriptionStatus === 'canceled' || sub?.revenuecatCancelledAt != null;
  // Stripe is the truth; `payment_status: 'cancelling'` is its mirror —
  // written by the customer.subscription.updated webhook and eagerly by the
  // cancel route. This is what renders "Cancels at period end" and arms the
  // reactivate control; it used to be hardcoded false.
  const isCancelling = sub?.paymentStatus === 'cancelling';
  const subscriptionStatus = getSubscriptionStatus(sub, tierName, isAdmin);
  const subscriptionId =
    sub?.provider === 'revenuecat'
      ? (sub?.revenuecatSubscriptionId ?? sub?.revenuecatCustomerId ?? null)
      : (sub?.stripeSubscriptionId ?? null);

  const commitment = extractCommitment(sub);
  const scheduledChange = extractScheduledChange(sub, tierName);
  const billingPeriod = (sub?.planType ??
    null) as AccountStateResponse['subscription']['billing_period'];
  const provider = (sub?.provider ?? 'stripe') as AccountStateResponse['subscription']['provider'];

  // The SAME state machine the billing gate admits on (billing-state.ts), so
  // can_run answers the same question the gate answers, and `billing_state`
  // says WHY.
  const billingSnapshot = billingSnapshotFromAccount(sub);
  const billingState = resolveBillingState(billingSnapshot);

  const state = {
    credits: {
      total: credits.total,
      daily: credits.daily,
      monthly: credits.monthly,
      extra: credits.extra,
      can_run: isAdmin ? true : billingStateAllowsRun(billingState),
      // Lifetime rollups, maintained from credit_ledger by the
      // apply_credit_ledger_lifetime_rollup trigger (migration
      // 20260729013905335). They read 0 on every account before that migration
      // because nothing had incremented them since the Python -> TS rewrite —
      // web and mobile both hardcoded 0 into their `credits` shape rather than
      // reading a column that was always 0 anyway. Surfaced here so those
      // surfaces show the real figures instead of a placeholder.
      lifetime_granted: Number(sub?.lifetimeGranted ?? 0) || 0,
      lifetime_purchased: Number(sub?.lifetimePurchased ?? 0) || 0,
      lifetime_used: Number(sub?.lifetimeUsed ?? 0) || 0,
      daily_refresh: null,
    },
    billing_state: isAdmin ? ('active' as const) : billingState,
    has_active_subscription: hasLiveSubscription(billingSnapshot),
    // The plan the account BEHAVES as, named the way the product names plans.
    // Additive: `tier` and `subscription` are unchanged in shape.
    plan: {
      key: resolved.plan.key,
      family: resolved.plan.family,
      label: resolved.display.label,
      sublabel: resolved.display.sublabel,
      status: resolved.plan.status,
      shape: resolved.plan.shape,
      rank: resolved.plan.rank,
      // The monthly amount of a paid plan, in USD (1 credit = $0.01). Null for
      // free, enterprise and a trial: they carry no self-serve amount.
      monthly_usd: resolved.plan.key === 'credits' && resolved.source === 'stored' ? monthlyUsd : null,
    },
    subscription: {
      // STORED, not resolved: this block describes the Stripe subscription, so
      // `tier_key` and its display name stay the pair Stripe sold. A trial does
      // not create a subscription, and reporting the trial plan here would tell
      // the billing UI to render a subscription that does not exist.
      tier_key: tierName,
      tier_display_name: isAdmin && tierName === 'none' ? 'Admin' : tier.displayName,
      status: subscriptionStatus,
      billing_period: billingPeriod,
      provider,
      subscription_id: subscriptionId,
      current_period_end: null,
      cancel_at_period_end: isCancelling,
      is_cancelled: isCancelled,
      cancellation_effective_date: null,
      has_scheduled_change: scheduledChange !== null,
      scheduled_change: scheduledChange,
      commitment,
      // RESOLVED: this is the same predicate the purchase-credits route gates
      // on (billing/routes/payments.ts). Reporting the stored tier's answer
      // here while the route enforced the resolved one would show a trialing
      // account a buy button the server rejects, or hide one it accepts.
      can_purchase_credits: isAdmin ? true : resolved.entitlements.canPurchaseCredits,
    },
    tier: {
      // RESOLVED: what the account behaves as, so this matches what every gate
      // enforces. `subscription.tier_key` above still carries the stored key.
      name: resolved.plan.key,
      display_name: isAdmin && tierName === 'none' ? 'Admin' : resolved.plan.displayName,
      // STORED: `monthly_credits` is the recurring GRANT, which Stripe owns. A
      // trial is an entitlement overlay and grants no credits, so the number
      // here must keep describing the subscription, not the trial.
      monthly_credits: monthlyUsd ?? tier.monthlyCredits,
      can_purchase_credits: isAdmin ? true : resolved.entitlements.canPurchaseCredits,
      entitlements,
    },
    enterprise_license_available: config.ENTERPRISE_LICENSE_AVAILABLE,
    // Surface the per-account contracted-Enterprise flag so the admin console
    // and the frontend can distinguish a real Enterprise contract (entitlements
    // sourced from `enterprise_entitled`, independent of billing tier) from a
    // self-serve demo or a self-host license. When true, the frontend hides
    // the self-serve "Enterprise features — Demo" toggle (a real contract
    // supersedes the demo) and the admin console shows the contract state.
    enterprise_entitled: enterpriseEntitledFromRow(sub),
    models: [],
    auto_topup: autoTopup,
    usage_this_period: usageThisPeriod,
  };

  return state;
}

export async function buildAccountState(accountId: string): Promise<AccountStateResponse> {
  return buildMinimalAccountState(accountId);
}

/**
 * Returns account state when there is no database (no-DB local mode).
 * No fake numbers — just `can_run: true` so nothing blocks the user.
 */
export function buildLocalAccountState(): AccountStateResponse {
  return {
    credits: {
      total: 0,
      daily: 0,
      monthly: 0,
      extra: 0,
      can_run: true,
      lifetime_granted: 0,
      lifetime_purchased: 0,
      lifetime_used: 0,
      daily_refresh: null,
    },
    billing_state: 'active',
    has_active_subscription: false,
    plan: {
      key: 'free',
      family: 'free',
      label: PLAN_FAMILY_LABELS.free,
      sublabel: null,
      status: 'current',
      shape: 'none',
      rank: PLAN_CATALOG.free?.rank ?? 1,
      monthly_usd: null,
    },
    subscription: {
      tier_key: 'free',
      tier_display_name: 'Free',
      status: 'active',
      billing_period: null,
      provider: 'stripe',
      subscription_id: null,
      current_period_end: null,
      cancel_at_period_end: false,
      is_cancelled: false,
      cancellation_effective_date: null,
      has_scheduled_change: false,
      scheduled_change: null,
      commitment: {
        has_commitment: false,
        can_cancel: true,
        commitment_type: null,
        months_remaining: null,
        commitment_end_date: null,
      },
      can_purchase_credits: false,
    },
    tier: {
      name: 'free',
      display_name: 'Free',
      monthly_credits: 0,
      can_purchase_credits: false,
      entitlements: getTierEntitlements('free'),
    },
    enterprise_license_available: config.ENTERPRISE_LICENSE_AVAILABLE,
    // No-DB local mode has no credit_accounts row, so the contracted-Enterprise
    // flag is false by construction (fail-closed).
    enterprise_entitled: false,
    models: [],
    auto_topup: {
      enabled: false,
      threshold: AUTO_TOPUP_DEFAULT_THRESHOLD,
      amount: AUTO_TOPUP_DEFAULT_AMOUNT,
      disabled_reason: null,
      last_failure_reason: null,
      last_failure_at: null,
    },
    usage_this_period: null,
  };
}

function extractCommitment(sub: CreditAccountRow): CommitmentInfo {
  if (!sub?.commitmentType || !sub.commitmentEndDate) {
    return {
      has_commitment: false,
      can_cancel: true,
      commitment_type: null,
      months_remaining: null,
      commitment_end_date: null,
    };
  }

  const endDate = new Date(sub.commitmentEndDate);
  const now = new Date();
  const monthsRemaining = Math.max(
    0,
    Math.ceil((endDate.getTime() - now.getTime()) / (30 * 86400000)),
  );
  const canCancel = endDate <= now;

  return {
    has_commitment: true,
    can_cancel: canCancel,
    commitment_type: sub.commitmentType,
    months_remaining: monthsRemaining,
    commitment_end_date: sub.commitmentEndDate,
  };
}

function getSubscriptionStatus(sub: CreditAccountRow, tierName: string, isAdmin: boolean): string {
  if (isAdmin && tierName === 'none') return 'active';
  if (!sub) return tierName === 'free' ? 'active' : 'no_subscription';
  if (sub.provider === 'revenuecat') {
    if (sub.revenuecatCancelledAt) return 'canceled';
    if (tierName === 'free') return 'no_subscription';
    if (sub.paymentStatus === 'past_due') return 'past_due';
    return 'active';
  }

  return sub.stripeSubscriptionStatus ?? (tierName === 'free' ? 'active' : 'no_subscription');
}

function extractScheduledChange(
  sub: CreditAccountRow,
  currentTierName: string,
): ScheduledChange | null {
  if (sub?.revenuecatPendingChangeProduct && sub.revenuecatPendingChangeDate) {
    const current = getTier(currentTierName);
    return {
      type: 'downgrade',
      current_tier: { name: current.name, display_name: current.displayName },
      target_tier: {
        name: sub.revenuecatPendingChangeProduct,
        display_name: sub.revenuecatPendingChangeProduct,
      },
      effective_date: sub.revenuecatPendingChangeDate,
    };
  }

  return null;
}
