import { backendApi } from "../api-client";
import {
  getAccountState as sdkGetAccountState,
  type AccountState,
} from '@kortix/sdk/projects-client';

// =============================================================================
// UNIFIED ACCOUNT STATE - Primary API for all billing data
//
// The account-state type + read now live in the SDK
// (packages/sdk/src/platform/projects-client/billing.ts) — it's the
// entitlement-gating data, not product-UI. Re-exported here so existing
// `import { AccountState } from '@/lib/api/billing'` call sites keep working.
// The Stripe checkout/portal/credits/auto-topup mutations below stay web-local.
// =============================================================================

export type { AccountState };

// =============================================================================
// MUTATION REQUEST/RESPONSE TYPES
// =============================================================================

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  model: string;
}

export interface DeductResult {
  success: boolean;
  cost: number;
  new_balance: number;
  transaction_id?: string;
}

export interface CreateCheckoutSessionRequest {
  tier_key: string;
  success_url: string;
  cancel_url: string;
  referral_id?: string;
  commitment_type?: 'monthly' | 'yearly' | 'yearly_commitment';
  locale?: string;
  /** Instance provisioning: managed VPS plan ID (e.g. 'pro', 'basic') */
  server_type?: string;
  /** Instance provisioning: managed VPS location (e.g. 'nbg1') */
  location?: string;
}

export interface CreateCheckoutSessionResponse {
  status:
    | 'upgraded'
    | 'downgrade_scheduled'
    | 'checkout_created'
    | 'subscription_created'
    | 'no_change'
    | 'new'
    | 'updated'
    | 'scheduled'
    | 'commitment_created'
    | 'commitment_blocks_downgrade';
  subscription_id?: string;
  schedule_id?: string;
  session_id?: string;
  url?: string;
  checkout_url?: string;
  effective_date?: string;
  scheduled_date?: string;
  current_tier?: string;
  target_tier?: string;
  message?: string;
  redirect_to_dashboard?: boolean;
  details?: {
    is_upgrade?: boolean;
    effective_date?: string;
    current_price?: number;
    new_price?: number;
    commitment_end_date?: string;
    months_remaining?: number;
    invoice?: {
      id: string;
      amount: number;
      currency: string;
    };
  };
}

export interface CreatePortalSessionRequest {
  return_url: string;
}

export interface CreatePortalSessionResponse {
  portal_url: string;
}

export interface PurchaseCreditsRequest {
  amount: number;
  success_url: string;
  cancel_url: string;
}

export interface PurchaseCreditsResponse {
  checkout_url: string;
}

export interface CancelSubscriptionRequest {
  feedback?: string;
}

export interface CancelSubscriptionResponse {
  success: boolean;
  cancel_at: number;
  message: string;
}

export interface ReactivateSubscriptionResponse {
  success: boolean;
  message: string;
}

export interface ScheduleDowngradeRequest {
  target_tier_key: string;
  commitment_type?: 'monthly' | 'yearly' | 'yearly_commitment';
}

export interface ScheduleDowngradeResponse {
  success: boolean;
  message: string;
  scheduled_date: string;
  current_tier: {
    name: string;
    display_name: string;
    monthly_credits: number;
  };
  target_tier: {
    name: string;
    display_name: string;
    monthly_credits: number;
  };
  billing_change: boolean;
  current_billing_period: string;
  target_billing_period: string;
  change_description: string;
}

export interface CancelScheduledChangeResponse {
  success: boolean;
  message: string;
}

export interface Transaction {
  id: string;
  user_id: string;
  type: 'credit' | 'debit';
  amount: number;
  description: string;
  reference_id?: string;
  reference_type?: string;
  created_at: string;
}

export interface UsageHistory {
  daily_usage: Record<string, {
    credits: number;
    debits: number;
    count: number;
  }>;
  total_period_usage: number;
  total_period_credits: number;
}

export interface CheckoutSessionDetails {
  session_id: string;
  amount_total: number;           // Final amount in cents (after discounts and tax)
  amount_subtotal: number;        // Amount before discounts/tax in cents
  amount_discount: number;        // Discount amount in cents
  amount_tax: number;             // Tax amount in cents
  currency: string;
  coupon_id: string | null;       // Internal Stripe coupon ID
  coupon_name: string | null;     // Coupon display name
  promotion_code: string | null;  // Customer-facing code (e.g., "HEHE2020")
  balance_transaction_id: string | null;  // txn_xxx for Stripe balance transaction
  status: string;
  payment_status: string;
}

// =============================================================================
// BILLING API
// =============================================================================

export const billingApi = {
  /**
   * Get unified account state - the single source of truth for all billing data.
   * This replaces getSubscription, getCreditBalance, and getAvailableModels.
   *
   * Pass `accountId` to scope the fetch to a specific account the user is a
   * member of (e.g. on /accounts/[id] pages). Without it, the backend uses the
   * user's first membership — fine for global surfaces like the user menu and
   * upgrade dialog, but wrong for the per-account billing page.
   *
   * The actual fetch + graceful-degrade logic lives in the SDK
   * (`@kortix/sdk/projects-client`'s `getAccountState`) — this is a thin
   * pass-through so existing `billingApi.getAccountState(...)` call sites
   * don't need to change.
   */
  async getAccountState(skipCache = false, accountId?: string): Promise<AccountState> {
    return sdkGetAccountState({ skipCache, accountId });
  },

  async deductUsage(params: { amount: number; description?: string }) {
    const response = await backendApi.post<DeductResult>('/billing/deduct-usage', params, { showErrors: false });
    if (response.error) throw response.error;
    return response.data!;
  },

  async deductTokenUsage(usage: TokenUsage) {
    const response = await backendApi.post<DeductResult>('/billing/deduct', usage);
    if (response.error) throw response.error;
    return response.data!;
  },

  async createCheckoutSession(request: CreateCheckoutSessionRequest, accountId?: string) {
    const response = await backendApi.post<CreateCheckoutSessionResponse>(
      '/billing/create-checkout-session',
      accountId ? { ...request, account_id: accountId } : request
    );
    if (response.error) throw response.error;

    const data = response.data!;
    if (data.checkout_url) {
      return {
        ...data,
        status: data.status || 'checkout_created',
        url: data.checkout_url
      } as CreateCheckoutSessionResponse;
    } else if ((data as any).success && data.subscription_id) {
      return {
        ...data,
        status: 'updated',
        message: data.message || 'Subscription updated successfully',
        subscription_id: data.subscription_id
      } as CreateCheckoutSessionResponse;
    }
    return data;
  },

  // Billing v2 — per-seat plan checkout. Stripe quantity = current member count.
  async createPerSeatCheckout(
    args: { success_url: string; cancel_url: string; locale?: string },
    accountId?: string,
  ) {
    const response = await backendApi.post<{
      status: 'subscription_created' | 'checkout_created';
      checkout_url?: string;
      subscription_id?: string;
      seat_count: number;
    }>('/billing/create-per-seat-checkout', accountId ? { ...args, account_id: accountId } : args);
    if (response.error) throw response.error;
    return response.data!;
  },

  // Billing v2 — legacy → per-seat voluntary claim. Runs the migration server-side
  // (create the $40/seat sub, cancel the machine subs, pre-pay the first seat out
  // of the unused machine value + return the rest as non-expiring credit, flip to
  // per_seat) and returns the result.
  async claimPerSeat(accountId?: string) {
    const response = await backendApi.post<{
      ok: boolean;
      status: string;
      credited_usd: number;
      first_seat_covered_usd: number;
      cancelled_subscriptions: number;
      reason?: string | null;
    }>('/billing/claim-per-seat', accountId ? { account_id: accountId } : {});
    if (response.error) throw response.error;
    return response.data!;
  },

  async createPortalSession(request: CreatePortalSessionRequest, accountId?: string) {
    const response = await backendApi.post<CreatePortalSessionResponse>(
      '/billing/create-portal-session',
      accountId ? { ...request, account_id: accountId } : request
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async cancelSubscription(request?: CancelSubscriptionRequest, accountId?: string) {
    const body: any = request || {};
    if (accountId) body.account_id = accountId;
    const response = await backendApi.post<CancelSubscriptionResponse>(
      '/billing/cancel-subscription',
      body,
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async reactivateSubscription(accountId?: string) {
    const response = await backendApi.post<ReactivateSubscriptionResponse>(
      '/billing/reactivate-subscription',
      accountId ? { account_id: accountId } : {},
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async purchaseCredits(request: PurchaseCreditsRequest, accountId?: string) {
    const response = await backendApi.post<PurchaseCreditsResponse>(
      '/billing/purchase-credits',
      accountId ? { ...request, account_id: accountId } : request
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async getTransactions(limit = 50, offset = 0, accountId?: string) {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (accountId) params.set('account_id', accountId);
    const response = await backendApi.get<{ transactions: Transaction[]; count: number }>(
      `/billing/transactions?${params.toString()}`
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async getUsageHistory(days = 30) {
    const response = await backendApi.get<UsageHistory>(
      `/billing/usage-history?days=${days}`
    );
    if (response.error) throw response.error;
    return response.data!;
  },


  async scheduleDowngrade(request: ScheduleDowngradeRequest, accountId?: string) {
    const response = await backendApi.post<ScheduleDowngradeResponse>(
      '/billing/schedule-downgrade',
      accountId ? { ...request, account_id: accountId } : request
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async cancelScheduledChange(accountId?: string) {
    const response = await backendApi.post<CancelScheduledChangeResponse>(
      '/billing/cancel-scheduled-change',
      accountId ? { account_id: accountId } : {}
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async syncSubscription(accountId?: string) {
    const response = await backendApi.post<{ success: boolean; message: string }>(
      '/billing/sync-subscription',
      accountId ? { account_id: accountId } : {}
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  /**
   * Get checkout session details from Stripe.
   * Used to retrieve actual transaction amounts (after discounts) for analytics tracking.
   */
  async getCheckoutSession(sessionId: string): Promise<CheckoutSessionDetails | null> {
    try {
      const response = await backendApi.get<CheckoutSessionDetails>(
        `/billing/checkout-session/${sessionId}`,
        { showErrors: false }
      );
      if (response.error) {
        console.warn('[Billing] Could not fetch checkout session:', response.error);
        return null;
      }
      return response.data!;
    } catch (error) {
      console.warn('[Billing] Error fetching checkout session:', error);
      return null;
    }
  }
};

// =============================================================================
// CONVENIENCE EXPORTS
// =============================================================================

export const getAccountState = (skipCache?: boolean) => billingApi.getAccountState(skipCache);
export const deductUsage = (params: { amount: number; description?: string }) =>
  billingApi.deductUsage(params);
export const deductTokenUsage = (usage: TokenUsage) => billingApi.deductTokenUsage(usage);
export const createCheckoutSession = (request: CreateCheckoutSessionRequest) =>
  billingApi.createCheckoutSession(request);
export const createPortalSession = (request: CreatePortalSessionRequest) =>
  billingApi.createPortalSession(request);
export const cancelSubscription = (feedback?: string) =>
  billingApi.cancelSubscription(feedback ? { feedback } : undefined);
export const reactivateSubscription = () => billingApi.reactivateSubscription();
export const purchaseCredits = (request: PurchaseCreditsRequest) =>
  billingApi.purchaseCredits(request);
export const getTransactions = (limit?: number, offset?: number) =>
  billingApi.getTransactions(limit, offset);
export const getUsageHistory = (days?: number) => billingApi.getUsageHistory(days);
export const scheduleDowngrade = (request: ScheduleDowngradeRequest) =>
  billingApi.scheduleDowngrade(request);
export const cancelScheduledChange = () => billingApi.cancelScheduledChange();
export const syncSubscription = () => billingApi.syncSubscription();
export const getCheckoutSession = (sessionId: string) => billingApi.getCheckoutSession(sessionId);

// =============================================================================
// INLINE CHECKOUT
// =============================================================================

export interface CreateInlineCheckoutRequest {
  tier_key: string;
  billing_period: 'monthly' | 'yearly';
  promo_code?: string;
}

export interface CreateInlineCheckoutResponse {
  // For new subscriptions
  client_secret?: string;
  subscription_id: string;
  tier_key: string;
  amount?: number;
  currency?: string;
  // For 100% discount promo codes (no payment needed)
  no_payment_required?: boolean;
  // For upgrades (no payment needed - uses existing payment method)
  upgraded?: boolean;
  previous_tier?: string;
  credits_granted?: number;
  message?: string;
}

export async function createInlineCheckout(
  request: CreateInlineCheckoutRequest,
  accountId?: string,
): Promise<CreateInlineCheckoutResponse> {
  const response = await backendApi.post<CreateInlineCheckoutResponse>(
    '/billing/create-inline-checkout',
    accountId ? { ...request, account_id: accountId } : request
  );
  if (response.error) throw response.error;
  return response.data!;
}

export interface ConfirmInlineCheckoutRequest {
  subscription_id: string;
  tier_key: string;
  payment_intent_id?: string;
}

export interface ConfirmInlineCheckoutResponse {
  success: boolean;
  tier: string;
  message: string;
}

export async function confirmInlineCheckout(
  request: ConfirmInlineCheckoutRequest,
  accountId?: string,
): Promise<ConfirmInlineCheckoutResponse> {
  const response = await backendApi.post<ConfirmInlineCheckoutResponse>(
    '/billing/confirm-inline-checkout',
    accountId ? { ...request, account_id: accountId } : request
  );
  if (response.error) throw response.error;
  return response.data!;
}

// =============================================================================
// AUTO-TOPUP
// =============================================================================

export interface AutoTopupConfig {
  enabled: boolean;
  threshold: number;
  amount: number;
}

export interface AutoTopupSetupStatus {
  has_payment_method: boolean;
  has_default_payment_method: boolean;
}

// Short per-call timeout + silent errors: these endpoints gate the billing
// UI, and `setup-status` makes round-trips to Stripe (customers.retrieve +
// paymentMethods.list) that can stall. We'd rather fail fast and render
// with defaults than hang the Auto Top-up panel.
const AUTO_TOPUP_TIMEOUT_MS = 8000;

export async function getAutoTopupSettings(accountId?: string): Promise<AutoTopupConfig> {
  const params = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  const response = await backendApi.get<AutoTopupConfig>(`/billing/auto-topup/settings${params}`, {
    timeout: AUTO_TOPUP_TIMEOUT_MS,
    showErrors: false,
  });
  if (response.error) throw response.error;
  return response.data!;
}

export async function configureAutoTopup(config: AutoTopupConfig, accountId?: string): Promise<{ success: boolean }> {
  const body: any = { ...config };
  if (accountId) body.account_id = accountId;
  const response = await backendApi.post<{ success: boolean }>('/billing/auto-topup/configure', body);
  if (response.error) throw response.error;
  return response.data!;
}

export async function getAutoTopupSetupStatus(accountId?: string): Promise<AutoTopupSetupStatus> {
  const params = accountId ? `?account_id=${encodeURIComponent(accountId)}` : '';
  const response = await backendApi.get<AutoTopupSetupStatus>(`/billing/auto-topup/setup-status${params}`, {
    timeout: AUTO_TOPUP_TIMEOUT_MS,
    showErrors: false,
  });
  if (response.error) throw response.error;
  return response.data!;
}

// =============================================================================
// INSTANCES (server types) — thin re-export
//
// The managed-VPS ("JustAVPS") instance admin fns now live in the SDK
// (packages/sdk/src/platform/platform-client/instance-admin.ts). Re-exported
// here, under their original names, so existing call sites don't change.
// =============================================================================

export {
  getJustavpsServerTypes as getServerTypes,
  createInstance,
  deleteInstance,
  markInstanceError,
  claimComputer,
  type ServerType,
  type ServerTypesResponse,
  type CreateInstanceRequest,
} from '@kortix/sdk/platform-client';
