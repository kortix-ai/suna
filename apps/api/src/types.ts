import { z } from 'zod';

// === Request Schemas (Router) === 

export const WebSearchRequestSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  max_results: z.number().int().min(1).max(10).default(5),
  search_depth: z.enum(['basic', 'advanced']).default('basic'),
  session_id: z.string().optional(),
});

export type WebSearchRequest = z.infer<typeof WebSearchRequestSchema>;

export const ImageSearchRequestSchema = z.object({
  query: z.string().min(1, 'Query is required'),
  max_results: z.number().int().min(1).max(20).default(5),
  safe_search: z.boolean().default(true),
  session_id: z.string().optional(),
});

export type ImageSearchRequest = z.infer<typeof ImageSearchRequestSchema>;

// === Response Types (Router) ===

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  published_date: string | null;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  query: string;
  cost: number;
}

export interface ImageSearchResult {
  title: string;
  url: string;
  thumbnail_url: string;
  source_url: string;
  width: number | null;
  height: number | null;
}

export interface ImageSearchResponse {
  results: ImageSearchResult[];
  query: string;
  cost: number;
}

// === Billing Types (Router billing service) ===

export interface BillingCheckResult {
  hasCredits: boolean;
  message: string;
  balance: number | null;
}

export interface BillingDeductResult {
  success: boolean;
  cost: number;
  newBalance: number;
  skipped?: boolean;
  reason?: string;
  transactionId?: string;
  error?: string;
}

// === Context Types ===

export interface AppContext {
  accountId: string;
  sandboxId?: string;
  keyId?: string;
}

// Context variables set by auth middleware (platform)
export interface AuthVariables {
  userId: string;
  userEmail: string;
  accountId?: string;
}

// Hono environment type (cron/billing)
export type AppEnv = {
  Variables: {
    userId: string;
    userEmail: string;
  };
};

// ─── Tier System (Billing) ──────────────────────────────────────────────────

export interface TierConfig {
  name: string;
  displayName: string;
  monthlyPrice: number;
  yearlyPrice: number;
  monthlyCredits: number;
  canPurchaseCredits: boolean;
  models: string[];
  dailyCreditConfig: DailyCreditConfig | null;
  hidden: boolean;
}

export interface DailyCreditConfig {
  dailyAmount: number;
  refreshIntervalHours: number;
  maxAccumulation: number;
}

// ─── Credit Accounts (Billing) ──────────────────────────────────────────────

export interface CreditAccount {
  id: string;
  accountId: string;
  balance: number;
  expiringCredits: number;
  nonExpiringCredits: number;
  dailyCreditsBalance: number;
  tier: string;
  provider: string;
  stripeSubscriptionId: string | null;
  stripeSubscriptionStatus: string | null;
  planType: string | null;
  billingCycleAnchor: string | null;
  nextCreditGrant: string | null;
  lastGrantDate: string | null;
  lastDailyRefresh: string | null;
  trialStatus: string | null;
  trialEndsAt: string | null;
  commitmentType: string | null;
  commitmentEndDate: string | null;
  scheduledTierChange: string | null;
  scheduledTierChangeDate: string | null;
  scheduledPriceId: string | null;
  lastProcessedInvoiceId: string | null;
  lastRenewalPeriodStart: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Billing Customers ──────────────────────────────────────────────────────

export interface BillingCustomer {
  id: string;
  accountId: string;
  stripeCustomerId: string;
  email: string | null;
  name: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Account State (API response) ───────────────────────────────────────────

export interface AccountStateResponse {
  credits: {
    total: number;
    daily: number;
    monthly: number;
    extra: number;
    can_run: boolean;
    daily_refresh: {
      enabled: boolean;
      daily_amount: number;
      refresh_interval_hours: number;
      last_refresh: string | null;
      next_refresh_at: string | null;
      seconds_until_refresh: number | null;
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
    scheduled_change: ScheduledChange | null;
    commitment: CommitmentInfo;
    can_purchase_credits: boolean;
  };
  tier: {
    name: string;
    display_name: string;
    monthly_credits: number;
    can_purchase_credits: boolean;
  };
  auto_topup: {
    enabled: boolean;
    threshold: number;
    amount: number;
  };
  instances: Array<{
    sandbox_id: string;
    external_id: string | null;
    name: string;
    provider: string;
    status: string;
    server_type: string | null;
    location: string | null;
    error_message?: string | null;
    is_included: boolean;
    stripe_subscription_item_id: string | null;
    created_at: string;
  }>;
  yolo_usage?: {
    used_percent: number;
    used_percent_precise: number;
    window_started: boolean;
    window_reset_in: number;
    window_reset_at: string;
  } | null;
  can_add_instances: boolean;
  /** True when a legacy paid user has no active machine and can claim one. */
  can_claim_computer?: boolean;
}

export interface ScheduledChange {
  type: 'downgrade';
  current_tier: { name: string; display_name: string; monthly_credits?: number };
  target_tier: { name: string; display_name: string; monthly_credits?: number };
  effective_date: string;
}

export interface CommitmentInfo {
  has_commitment: boolean;
  can_cancel: boolean;
  commitment_type: string | null;
  months_remaining: number | null;
  commitment_end_date: string | null;
}

// ─── API Request/Response Types (Billing) ───────────────────────────────────

export interface CreateCheckoutRequest {
  tier_key: string;
  success_url: string;
  cancel_url: string;
  commitment_type?: 'monthly' | 'yearly' | 'yearly_commitment';
  locale?: string;
  referral_id?: string;
}

export interface CreateInlineCheckoutRequest {
  tier_key: string;
  billing_period: 'monthly' | 'yearly';
  promo_code?: string;
}

export interface CreatePortalRequest {
  return_url: string;
}

export interface PurchaseCreditsRequest {
  amount: number;
  success_url: string;
  cancel_url: string;
}

export interface CancelSubscriptionRequest {
  feedback?: string;
}

export interface ScheduleDowngradeRequest {
  target_tier_key: string;
  commitment_type?: 'monthly' | 'yearly' | 'yearly_commitment';
}

export interface TokenUsageRequest {
  prompt_tokens: number;
  completion_tokens: number;
  model: string;
}

export interface DeductResult {
  success: boolean;
  cost: number;
  new_balance: number;
  transaction_id?: string;
  error?: string;
}
