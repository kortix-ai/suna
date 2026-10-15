import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';
import { config } from '../../config';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { isoValue } from '../../shared/cost-values';
import type {
  AccountAccessGrace,
  AccountContract,
  AccountEnterpriseOffer,
  AccountStateResponse,
  AccountTrial,
  CommitmentInfo,
  ScheduledChange,
} from '../../types';
import { getCreditAccount } from '../repositories/credit-accounts';
import { getAutoTopupSettings } from './auto-topup';
import { resolveAccountBilling } from './billing-cache';
import { ACCESS_GRACE_DAYS, type ResolvedBilling } from './resolve-billing';
import { type ContractRow, getContractState } from './enterprise-contracts';
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
  if (!account) {
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

  // RESOLVED billing (billing/services/resolve-billing.ts): the billing plan,
  // the Enterprise layer (off | demo | licensed) and the entitlements with the
  // overrides applied. `sub` is passed in so this costs no extra read; the
  // request already holds the row. `plan` is the billing plan; `tier` is what
  // the gates enforce (Enterprise limits when licensed).
  // Started here, awaited with the reads below: none of them needs it.
  const resolvedPending = resolveAccountBilling(accountId, { row: sub });

  // All of these are independent of one another (each keyed only on accountId
  // and/or the `account` row already fetched above) — run them concurrently
  // instead of ~8 sequential round-trips.
  const [resolved, [credits, isAdmin, entitlements, autoTopup, usageThisPeriod], { active: contract, offer, lastEnded }] =
    await Promise.all([resolvedPending, Promise.all([
      getCreditSummary(account),
      isPlatformAdmin(accountId),
      // The resolved entitlements (trial, grace and overrides applied), not the
      // stored tier's static ones.
      getAccountEntitlements(accountId, account),
      getAutoTopupSettings(accountId, account),
      sub
        ? getUsageBreakdownThisPeriod(accountId, currentPeriodStart(sub.billingCycleAnchor ?? null)).catch(() => null)
        : Promise.resolve(null),
    ]), getContractState(accountId)]);

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
      // free: it carries no self-serve amount.
      monthly_usd: resolved.plan.key === 'credits' && tierName === 'credits' ? monthlyUsd : null,
    },
    subscription: {
      // STORED, not resolved: this block describes the Stripe subscription, so
      // `tier_key` and its display name stay the pair Stripe sold.
      tier_key: tierName,
      tier_display_name: isAdmin && tierName === 'none' ? 'Admin' : tier.displayName,
      // STORED, like the rest of this block: what the account pays.
      monthly_usd: monthlyUsd,
      status: subscriptionStatus,
      billing_period: billingPeriod,
      provider,
      subscription_id: subscriptionId,
      current_period_end: periodEndSeconds(sub, tierName),
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
      name: resolved.features.key,
      display_name: isAdmin && tierName === 'none' ? 'Admin' : resolved.features.displayName,
      // STORED: `monthly_credits` is the recurring GRANT, which Stripe owns.
      monthly_credits: monthlyUsd ?? tier.monthlyCredits,
      can_purchase_credits: isAdmin ? true : resolved.entitlements.canPurchaseCredits,
      entitlements,
    },
    enterprise_license_available: config.ENTERPRISE_LICENSE_AVAILABLE,
    enterprise_entitled: resolved.enterprise !== 'off',
    // Trials are removed (plans-and-access.md): always null, kept for the wire shape.
    trial: null,
    enterprise: { state: resolved.enterprise },
    contract: contractOf(contract),
    enterprise_offer: offerOf(offer),
    grace: graceOf(resolved, lastEnded),
    models: [],
    auto_topup: autoTopup,
    usage_this_period: usageThisPeriod,
  };

  return state;
}

const DAY_MS = 24 * 60 * 60 * 1000;


function contractOf(row: ContractRow | null): AccountContract | null {
  if (!row) return null;
  return {
    id: row.id,
    license_usd: Number(row.licenseUsd),
    term_months: row.termMonths,
    collection: row.collection as AccountContract['collection'],
    starts_at: isoValue(row.startsAt),
    ends_at: isoValue(row.endsAt),
    renews: row.autoRenews,
  };
}

function offerOf(row: ContractRow | null): AccountEnterpriseOffer | null {
  if (!row) return null;
  return {
    id: row.id,
    license_usd: Number(row.licenseUsd),
    term_months: row.termMonths,
    collection: row.collection as AccountEnterpriseOffer['collection'],
  };
}

/** SSO/SCIM grace after a license (its end date) ended. */
function graceOf(resolved: ResolvedBilling, lastEnded: ContractRow | null): AccountAccessGrace | null {
  if (resolved.grace) return { reason: resolved.grace.reason, ends_at: resolved.grace.endsAt };
  if (resolved.features.family === 'enterprise' || !lastEnded?.endedAt) return null;
  const endsMs = new Date(lastEnded.endedAt).getTime() + ACCESS_GRACE_DAYS * DAY_MS;
  return endsMs > Date.now() ? { reason: 'contract_ended', ends_at: new Date(endsMs).toISOString() } : null;
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
      monthly_usd: null,
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
    trial: null,
    enterprise: { state: 'off' },
    contract: null,
    enterprise_offer: null,
    grace: null,
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

/**
 * When the current paid period ends (the next renewal), in Unix seconds: the
 * anchor-aligned date after the current period start. Null without a live
 * Stripe credits plan.
 */
function periodEndSeconds(sub: CreditAccountRow, tierName: string): number | null {
  if (tierName !== 'credits' || !sub?.stripeSubscriptionId || !sub.billingCycleAnchor) return null;
  const start = currentPeriodStart(sub.billingCycleAnchor);
  if (!start) return null;
  // A period is at most 31 days, so 32 days past its start lands in the next one.
  const end = currentPeriodStart(sub.billingCycleAnchor, new Date(new Date(start).getTime() + 32 * 86_400_000));
  return end ? Math.floor(new Date(end).getTime() / 1000) : null;
}

function extractScheduledChange(
  sub: CreditAccountRow,
  currentTierName: string,
): ScheduledChange | null {
  // A lowered credits amount waiting for the renewal (setPlan's cut).
  if (sub?.scheduledMonthlyUsd != null && currentTierName === 'credits') {
    const from = planMonthlyUsd(sub);
    const to = Number(sub.scheduledMonthlyUsd);
    return {
      type: 'downgrade',
      current_tier: { name: 'credits', display_name: 'Credits', monthly_credits: from * 100, monthly_usd: from },
      target_tier: { name: 'credits', display_name: 'Credits', monthly_credits: to * 100, monthly_usd: to },
      effective_date: sub.scheduledTierChangeDate ?? new Date((periodEndSeconds(sub, currentTierName) ?? 0) * 1000).toISOString(),
    };
  }

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
