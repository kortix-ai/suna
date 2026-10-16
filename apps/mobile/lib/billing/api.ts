/**
 * Unified billing types and selectors. The calls are `@kortix/sdk`'s
 * (`getAccountState`, `cancelScheduledChange`, …), used in ./hooks.
 */

// =============================================================================
// UNIFIED ACCOUNT STATE
// =============================================================================

export interface AccountState {
  /**
   * The plan the account behaves as (trial-aware). Absent on API versions
   * that predate it; read it through `getPlanFamily` (lib/billing/plan-action).
   */
  plan?: {
    key?: string;
    family: 'free' | 'credits' | 'enterprise';
    label: string;
    sublabel?: string | null;
    /** The paid plan's monthly amount in USD; null for free and enterprise. */
    monthly_usd?: number | null;
  } | null;
  /** @deprecated Trials are removed: always null. */
  trial?: { plan: 'credits' | 'enterprise'; ends_at: string; days_left: number } | null;
  /** The Enterprise feature layer. Absent on older APIs. */
  enterprise?: { state: 'off' | 'demo' | 'licensed' };
  can_manage_billing?: boolean;
  /** USD amounts (1 credit = $0.01). Show them with `formatUsdAsCredits`. */
  credits: {
    total: number;
    daily: number;
    monthly: number;
    extra: number;
    can_run: boolean;
    /** Lifetime rollups derived server-side from credit_ledger. Optional —
     *  absent on API versions that predate them. */
    lifetime_granted?: number;
    lifetime_purchased?: number;
    lifetime_used?: number;
    daily_refresh: {
      enabled: boolean;
      daily_amount: number;
      refresh_interval_hours: number;
      last_refresh?: string;
      next_refresh_at?: string;
      seconds_until_refresh?: number;
    } | null;
  };
  subscription: {
    tier_key: string;
    tier_display_name: string;
    status: string;
    billing_period: 'monthly' | 'yearly' | 'yearly_commitment' | null;
    provider: 'stripe' | 'revenuecat' | 'local';
    subscription_id: string | null;
    current_period_end: number | null;
    cancel_at_period_end: boolean;
    is_trial: boolean;
    trial_status: string | null;
    trial_ends_at: string | null;
    is_cancelled: boolean;
    cancellation_effective_date: string | null;
    has_scheduled_change: boolean;
    scheduled_change: {
      type: 'downgrade';
      current_tier: {
        name: string;
        display_name: string;
        monthly_credits?: number;
      };
      target_tier: {
        name: string;
        display_name: string;
        monthly_credits?: number;
      };
      effective_date: string;
    } | null;
    commitment: {
      has_commitment: boolean;
      can_cancel: boolean;
      commitment_type?: string | null;
      months_remaining?: number | null;
      commitment_end_date?: string | null;
    };
    can_purchase_credits: boolean;
  };
  models: Array<{
    id: string;
    name: string;
    provider: string;
    allowed: boolean;
    context_window: number;
    capabilities: string[];
    priority: number;
    recommended: boolean;
  }>;
  limits: {
    projects: { current: number; max: number };
    threads: { current: number; max: number };
    concurrent_runs: number;
    custom_workers: number;
    scheduled_triggers: number;
    app_triggers: number;
  };
  tier: {
    name: string;
    display_name: string;
    monthly_credits: number;
    can_purchase_credits: boolean;
  };
  _cache?: {
    cached: boolean;
    ttl_seconds?: number;
    local_mode?: boolean;
  };
}

// =============================================================================
// SELECTORS - Helper functions to extract data from account state
// =============================================================================

export const accountStateSelectors = {
  canRun: (state: AccountState | undefined) => state?.credits.can_run ?? false,
  totalCredits: (state: AccountState | undefined) => state?.credits.total ?? 0,
  tierKey: (state: AccountState | undefined) => state?.subscription.tier_key ?? 'none',
  tierDisplayName: (state: AccountState | undefined) =>
    state?.subscription.tier_display_name ?? 'No Plan',
  isTrial: (state: AccountState | undefined) => state?.subscription.is_trial ?? false,
  isCancelled: (state: AccountState | undefined) => state?.subscription.is_cancelled ?? false,
  allowedModels: (state: AccountState | undefined) => state?.models.filter((m) => m.allowed) ?? [],
  isModelAllowed: (state: AccountState | undefined, modelId: string) =>
    state?.models.find((m) => m.id === modelId)?.allowed ?? false,
  scheduledChange: (state: AccountState | undefined) => state?.subscription.scheduled_change,
  hasScheduledChange: (state: AccountState | undefined) =>
    state?.subscription.has_scheduled_change ?? false,
  canPurchaseCredits: (state: AccountState | undefined) =>
    state?.subscription.can_purchase_credits ?? false,
  dailyCreditsInfo: (state: AccountState | undefined) => state?.credits.daily_refresh,
};

// Re-export types for backward compatibility
export type { SubscriptionInfo, CreditBalance, BillingStatus } from './hooks';
