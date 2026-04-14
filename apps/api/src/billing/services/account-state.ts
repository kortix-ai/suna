import { eq, and, inArray } from 'drizzle-orm';
import {
  getCreditAccount,
  getSubscriptionInfo,
} from '../repositories/credit-accounts';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';
import {
  getTier,
  getDailyCreditConfig,
  isPaidTier,
  isLegacyPaidTier,
  MINIMUM_CREDIT_FOR_RUN,
} from './tiers';
import { getCreditSummary } from './credits';
import { getAutoTopupSettings } from './auto-topup';
import { isPlatformAdmin } from '../../shared/platform-roles';
import { config } from '../../config';
import type {
  AccountStateResponse,
  ScheduledChange,
  CommitmentInfo,
} from '../../types';

async function getYoloUsage(serviceKey: string | null): Promise<AccountStateResponse['yolo_usage']> {
  if (config.ENV_MODE !== 'cloud') return null;
  if (!serviceKey) return null;
  try {
    const res = await fetch(`${config.KORTIX_YOLO_URL}/me`, {
      headers: { Authorization: `Bearer ${serviceKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return {
      used_percent: Number(data?.usage?.usedPercent ?? 0),
      used_percent_precise: Number(data?.usage?.usedPercentPrecise ?? 0),
      window_started: Boolean(data?.usage?.windowStarted),
      window_reset_in: Number(data?.usage?.windowResetIn ?? 0),
      window_reset_at: String(data?.usage?.windowResetAt ?? new Date().toISOString()),
    };
  } catch {
    return null;
  }
}

export async function buildMinimalAccountState(accountId: string): Promise<AccountStateResponse> {
  const credits = await getCreditSummary(accountId);
  const sub = await getSubscriptionInfo(accountId);
  const isAdmin = await isPlatformAdmin(accountId);

  // If no credit_accounts row exists, user hasn't been initialized yet.
  // Return 'none' so middleware redirects to /setting-up for auto-initialization.
  // Only return 'free' when the row actually exists with tier='free'.
  const tierName = sub ? (sub.tier ?? 'free') : 'none';
  const tier = getTier(tierName);
  const dailyConfig = getDailyCreditConfig(tierName);

  let dailyRefresh = null;
  if (dailyConfig) {
    const lastRefresh = sub?.lastDailyRefresh ?? null;
    const nextRefresh = lastRefresh
      ? new Date(new Date(lastRefresh).getTime() + dailyConfig.refreshIntervalHours * 3600000).toISOString()
      : null;
    const secondsUntil = nextRefresh
      ? Math.max(0, Math.floor((new Date(nextRefresh).getTime() - Date.now()) / 1000))
      : null;

    dailyRefresh = {
      enabled: true,
      daily_amount: dailyConfig.dailyAmount,
      refresh_interval_hours: dailyConfig.refreshIntervalHours,
      last_refresh: lastRefresh,
      next_refresh_at: nextRefresh,
      seconds_until_refresh: secondsUntil,
    };
  }

  const isTrial = sub?.trialStatus === 'active';
  const isCancelled = sub?.stripeSubscriptionStatus === 'canceled'
    || (sub?.revenuecatCancelledAt != null);

  const commitment = extractCommitment(sub);
  const scheduledChange = extractScheduledChange(sub, tierName);

  // Auto-topup settings
  const autoTopup = await getAutoTopupSettings(accountId);

  // User's instances (sandboxes)
  let instances: any[] = [];
  let yoloUsage: AccountStateResponse['yolo_usage'] = null;
  try {
    const { db } = await import('../../shared/db');
    const { sandboxes } = await import('@kortix/db');

    const sandboxRows = await db
      .select()
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.accountId, accountId),
          inArray(sandboxes.status, ['active', 'provisioning', 'stopped', 'error']),
        ),
      );

    instances = sandboxRows.map((row) => {
      const metadata = row.metadata as Record<string, unknown> | null;
      return {
        sandbox_id: row.sandboxId,
        external_id: row.externalId || null,
        name: row.name,
        provider: row.provider,
        status: row.status,
        server_type: metadata?.serverType ?? null,
        location: metadata?.location ?? null,
        error_message: metadata?.errorMessage ?? null,
        is_included: row.isIncluded ?? false,
        stripe_subscription_id: (row as any).stripeSubscriptionId || (metadata?.stripe_subscription_id as string) || null,
        stripe_subscription_item_id: row.stripeSubscriptionItemId ?? null,
        cancel_at_period_end: (row as any).cancelAtPeriodEnd || !!(metadata?.cancel_at_period_end),
        cancel_at: (row as any).cancelAt || (metadata?.cancel_at as string) || null,
        created_at: row.createdAt.toISOString(),
      };
    });

    const serviceKey = sandboxRows
      .map((row: any) => (row.config as Record<string, unknown> | null)?.serviceKey)
      .find((value: unknown): value is string => typeof value === 'string' && value.length > 0)
      ?? null;
    yoloUsage = await getYoloUsage(serviceKey);
  } catch {
    // DB may not be available in local mode
  }

  // Legacy paid users with no active machine can claim a free default computer
  const hasActiveMachine = instances.some((i: any) => i.status === 'active' || i.status === 'provisioning');
  let canClaimComputer = isLegacyPaidTier(tierName) && !hasActiveMachine;

  // Cloud-only: also check old public.credit_accounts for legacy tier
  if (!canClaimComputer && !hasActiveMachine) {
    try {
      const { config } = await import('../../config');
      if (config.isCloud()) {
        const { getPublicSchemaTier } = await import('../repositories/credit-accounts');
        const publicTier = await getPublicSchemaTier(accountId);
        if (publicTier && isLegacyPaidTier(publicTier)) {
          canClaimComputer = true;
        }
      }
    } catch { /* local mode — no DB */ }
  }

  const state = {
    credits: {
      total: credits.total,
      daily: credits.daily,
      monthly: credits.monthly,
      extra: credits.extra,
      can_run: isAdmin ? true : credits.canRun,
      daily_refresh: dailyRefresh,
    },
    subscription: {
      tier_key: tierName,
      tier_display_name: isAdmin && tierName === 'none' ? 'Admin' : tier.displayName,
      status: isAdmin && tierName === 'none'
        ? 'active'
        : (sub?.stripeSubscriptionStatus ?? (tierName === 'free' ? 'active' : 'no_subscription')),
      billing_period: (sub?.planType as any) ?? null,
      provider: (sub?.provider as any) ?? 'stripe',
      subscription_id: sub?.stripeSubscriptionId ?? null,
      current_period_end: null,
      cancel_at_period_end: false,
      is_trial: isTrial,
      trial_status: sub?.trialStatus ?? null,
      trial_ends_at: sub?.trialEndsAt ?? null,
      is_cancelled: isCancelled,
      cancellation_effective_date: null,
      has_scheduled_change: scheduledChange !== null,
      scheduled_change: scheduledChange,
      commitment,
      can_purchase_credits: isAdmin ? true : tier.canPurchaseCredits,
    },
    tier: {
      name: tier.name,
      display_name: isAdmin && tierName === 'none' ? 'Admin' : tier.displayName,
      monthly_credits: tier.monthlyCredits,
      can_purchase_credits: isAdmin ? true : tier.canPurchaseCredits,
    },
    auto_topup: autoTopup,
    instances,
    yolo_usage: yoloUsage,
    can_add_instances: isAdmin || isPaidTier(tierName),
    can_claim_computer: canClaimComputer,
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
      daily_refresh: null,
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
      is_trial: false,
      trial_status: null,
      trial_ends_at: null,
      is_cancelled: false,
      cancellation_effective_date: null,
      has_scheduled_change: false,
      scheduled_change: null,
      commitment: { has_commitment: false, can_cancel: true, commitment_type: null, months_remaining: null, commitment_end_date: null },
      can_purchase_credits: false,
    },
    tier: {
      name: 'free',
      display_name: 'Free',
      monthly_credits: 0,
      can_purchase_credits: false,
    },
    auto_topup: {
      enabled: false,
      threshold: AUTO_TOPUP_DEFAULT_THRESHOLD,
      amount: AUTO_TOPUP_DEFAULT_AMOUNT,
    },
    instances: [],
    yolo_usage: null,
    can_add_instances: false,
    can_claim_computer: false,
  };
}

function extractCommitment(sub: Awaited<ReturnType<typeof getSubscriptionInfo>>): CommitmentInfo {
  if (!sub?.commitmentType || !sub.commitmentEndDate) {
    return { has_commitment: false, can_cancel: true, commitment_type: null, months_remaining: null, commitment_end_date: null };
  }

  const endDate = new Date(sub.commitmentEndDate);
  const now = new Date();
  const monthsRemaining = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / (30 * 86400000)));
  const canCancel = endDate <= now;

  return {
    has_commitment: true,
    can_cancel: canCancel,
    commitment_type: sub.commitmentType,
    months_remaining: monthsRemaining,
    commitment_end_date: sub.commitmentEndDate,
  };
}

function extractScheduledChange(
  sub: Awaited<ReturnType<typeof getSubscriptionInfo>>,
  currentTierName: string,
): ScheduledChange | null {
  if (sub?.scheduledTierChange && sub.scheduledTierChangeDate) {
    const current = getTier(currentTierName);
    const target = getTier(sub.scheduledTierChange);
    return {
      type: 'downgrade',
      current_tier: { name: current.name, display_name: current.displayName, monthly_credits: current.monthlyCredits },
      target_tier: { name: target.name, display_name: target.displayName, monthly_credits: target.monthlyCredits },
      effective_date: sub.scheduledTierChangeDate,
    };
  }

  if (sub?.revenuecatPendingChangeProduct && sub.revenuecatPendingChangeDate) {
    const current = getTier(currentTierName);
    return {
      type: 'downgrade',
      current_tier: { name: current.name, display_name: current.displayName },
      target_tier: { name: sub.revenuecatPendingChangeProduct, display_name: sub.revenuecatPendingChangeProduct },
      effective_date: sub.revenuecatPendingChangeDate,
    };
  }

  return null;
}
