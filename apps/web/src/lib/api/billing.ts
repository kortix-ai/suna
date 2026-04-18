import { backendApi } from "../api-client";

// =============================================================================
// UNIFIED ACCOUNT STATE - Primary API for all billing data
// =============================================================================

export interface AccountState {
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
  }>;
  limits?: {
    concurrent_runs: {
      running_count: number;
      limit: number;
      can_start: boolean;
      tier_name: string;
    };
    ai_worker_count: {
      current_count: number;
      limit: number;
      can_create: boolean;
      tier_name: string;
    };
    custom_mcp_count: {
      current_count: number;
      limit: number;
      can_create: boolean;
      tier_name: string;
    };
  };
  tier: {
    name: string;
    display_name: string;
    monthly_credits: number;
    can_purchase_credits: boolean;
  };
  auto_topup?: {
    enabled: boolean;
    threshold: number;
    amount: number;
  };
  instances?: Array<{
    sandbox_id: string;
    name: string;
    provider: string;
    status: string;
    server_type: string | null;
    location: string | null;
    is_included: boolean;
    stripe_subscription_id: string | null;
    stripe_subscription_item_id: string | null;
    cancel_at_period_end?: boolean;
    cancel_at?: string | null;
    created_at: string;
  }>;
  yolo_usage?: {
    used_percent: number;
    used_percent_precise: number;
    window_started: boolean;
    window_reset_in: number;
    window_reset_at: string;
  } | null;
  can_add_instances?: boolean;
  can_claim_computer?: boolean;
  _cache?: {
    cached: boolean;
    ttl_seconds?: number;
    local_mode?: boolean;
  };
}

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

export interface TrialStatus {
  has_trial: boolean;
  trial_status?: 'none' | 'active' | 'expired' | 'converted' | 'cancelled' | 'used';
  trial_started_at?: string;
  trial_ends_at?: string;
  trial_mode?: string;
  remaining_days?: number;
  credits_remaining?: number;
  tier?: string;
  can_start_trial?: boolean;
  message?: string;
  trial_history?: {
    started_at?: string;
    ended_at?: string;
    converted_to_paid?: boolean;
  };
}

export interface TrialStartRequest {
  success_url: string;
  cancel_url: string;
}

export interface TrialStartResponse {
  checkout_url: string;
  session_id: string;
}

export interface TrialCheckoutRequest {
  success_url: string;
  cancel_url: string;
}

export interface TrialCheckoutResponse {
  checkout_url: string;
  session_id: string;
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

function getDefaultAccountState(): AccountState {
  return {
    credits: {
      total: 0,
      daily: 0,
      monthly: 0,
      extra: 0,
      can_run: false,
      daily_refresh: null,
    },
    subscription: {
      tier_key: 'none',
      tier_display_name: 'No Plan',
      status: 'no_subscription',
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
      commitment: {
        has_commitment: false,
        can_cancel: true,
        commitment_type: null,
        months_remaining: null,
        commitment_end_date: null,
      },
      can_purchase_credits: false,
    },
    models: [],
    limits: {
      concurrent_runs: {
        running_count: 0,
        limit: 0,
        can_start: false,
        tier_name: 'none'
      },
      ai_worker_count: {
        current_count: 0,
        limit: 0,
        can_create: false,
        tier_name: 'none'
      },
      custom_mcp_count: {
        current_count: 0,
        limit: 0,
        can_create: false,
        tier_name: 'none'
      },
    },
    tier: {
      name: 'none',
      display_name: 'No Plan',
      monthly_credits: 0,
      can_purchase_credits: false,
    },
  };
}

// =============================================================================
// BILLING API
// =============================================================================

export const billingApi = {
  /**
   * Get unified account state - the single source of truth for all billing data.
   * This replaces getSubscription, getCreditBalance, and getAvailableModels.
   */
  async getAccountState(skipCache = false): Promise<AccountState> {
    const params = skipCache ? '?skip_cache=true' : '';
    const response = await backendApi.get<AccountState>(`/billing/account-state${params}`, {
      showErrors: false,
    });
    const isGracefulDisabledResponse = response.error?.status === 404
      && /billing is not enabled/i.test(response.error.message || '');
    if (response.error && response.error.status !== 401 && !isGracefulDisabledResponse) {
      throw response.error;
    }
    if (response.error) {
      return getDefaultAccountState();
    }
    return response.data!;
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

  async createCheckoutSession(request: CreateCheckoutSessionRequest) {
    const response = await backendApi.post<CreateCheckoutSessionResponse>(
      '/billing/create-checkout-session',
      request
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

  async createPortalSession(request: CreatePortalSessionRequest) {
    const response = await backendApi.post<CreatePortalSessionResponse>(
      '/billing/create-portal-session',
      request
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async cancelSubscription(request?: CancelSubscriptionRequest) {
    const response = await backendApi.post<CancelSubscriptionResponse>(
      '/billing/cancel-subscription',
      request || {}
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async reactivateSubscription() {
    const response = await backendApi.post<ReactivateSubscriptionResponse>(
      '/billing/reactivate-subscription'
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async purchaseCredits(request: PurchaseCreditsRequest) {
    const response = await backendApi.post<PurchaseCreditsResponse>(
      '/billing/purchase-credits',
      request
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async getTransactions(limit = 50, offset = 0) {
    const response = await backendApi.get<{ transactions: Transaction[]; count: number }>(
      `/billing/transactions?limit=${limit}&offset=${offset}`
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

  async getTrialStatus() {
    const response = await backendApi.get<TrialStatus>('/billing/trial/status');
    if (response.error) throw response.error;
    return response.data!;
  },

  async startTrial(request: TrialStartRequest) {
    const response = await backendApi.post<TrialStartResponse>('/billing/trial/start', request);
    if (response.error) throw response.error;
    return response.data!;
  },

  async createTrialCheckout(request: TrialCheckoutRequest) {
    const response = await backendApi.post<TrialCheckoutResponse>(
      '/billing/trial/create-checkout',
      request
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async cancelTrial() {
    const response = await backendApi.post<{ success: boolean; message: string; subscription_status: string }>(
      '/billing/trial/cancel',
      {}
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async scheduleDowngrade(request: ScheduleDowngradeRequest) {
    const response = await backendApi.post<ScheduleDowngradeResponse>(
      '/billing/schedule-downgrade',
      request
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async cancelScheduledChange() {
    const response = await backendApi.post<CancelScheduledChangeResponse>(
      '/billing/cancel-scheduled-change'
    );
    if (response.error) throw response.error;
    return response.data!;
  },

  async syncSubscription() {
    const response = await backendApi.post<{ success: boolean; message: string }>(
      '/billing/sync-subscription'
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
export const getTrialStatus = () => billingApi.getTrialStatus();
export const startTrial = (request: TrialStartRequest) => billingApi.startTrial(request);
export const createTrialCheckout = (request: TrialCheckoutRequest) => 
  billingApi.createTrialCheckout(request);
export const cancelTrial = () => billingApi.cancelTrial();
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
  request: CreateInlineCheckoutRequest
): Promise<CreateInlineCheckoutResponse> {
  const response = await backendApi.post<CreateInlineCheckoutResponse>(
    '/billing/create-inline-checkout',
    request
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
  request: ConfirmInlineCheckoutRequest
): Promise<ConfirmInlineCheckoutResponse> {
  const response = await backendApi.post<ConfirmInlineCheckoutResponse>(
    '/billing/confirm-inline-checkout',
    request
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

export async function getAutoTopupSettings(): Promise<AutoTopupConfig> {
  const response = await backendApi.get<AutoTopupConfig>('/billing/auto-topup/settings', {
    timeout: AUTO_TOPUP_TIMEOUT_MS,
    showErrors: false,
  });
  if (response.error) throw response.error;
  return response.data!;
}

export async function configureAutoTopup(config: AutoTopupConfig): Promise<{ success: boolean }> {
  const response = await backendApi.post<{ success: boolean }>('/billing/auto-topup/configure', config);
  if (response.error) throw response.error;
  return response.data!;
}

export async function getAutoTopupSetupStatus(): Promise<AutoTopupSetupStatus> {
  const response = await backendApi.get<AutoTopupSetupStatus>('/billing/auto-topup/setup-status', {
    timeout: AUTO_TOPUP_TIMEOUT_MS,
    showErrors: false,
  });
  if (response.error) throw response.error;
  return response.data!;
}

// =============================================================================
// INSTANCES (server types)
// =============================================================================

export interface ServerType {
  name: string;
  description: string;
  cores: number;
  memory: number;
  disk: number;
  cpuType: 'shared' | 'dedicated';
  architecture: 'x86' | 'arm';
  priceMonthly: number;
  priceMonthlyMarkup: number;
  location: string;
}

export interface ServerTypesResponse {
  serverTypes: ServerType[];
  location: string;
  defaultServerType?: string;
  defaultLocation?: string;
}

export async function getServerTypes(location?: string): Promise<ServerTypesResponse> {
  const params = location ? `?location=${location}` : '';
  const response = await backendApi.get<ServerTypesResponse>(
    `/platform/sandbox/justavps/server-types${params}`
  );
  if (response.error) {
    if (response.error.status === 404 && /justavps provider is not enabled/i.test(response.error.message || '')) {
      return {
        serverTypes: [],
        location: location || 'hel1',
      };
    }
    throw response.error;
  }
  return response.data!;
}

export interface CreateInstanceRequest {
  provider: 'justavps';
  serverType?: string;
  location?: string;
  name?: string;
  backgroundProvisioning?: boolean;
}

export async function createInstance(request: CreateInstanceRequest): Promise<any> {
  const response = await backendApi.post<any>('/platform/sandbox', request, { timeout: 180000 });
  if (response.error) throw response.error;
  return response.data!;
}

export async function deleteInstance(sandboxId: string): Promise<{ success: boolean }> {
  const response = await backendApi.delete<{ success: boolean }>(`/platform/sandbox?sandbox_id=${sandboxId}`);
  if (response.error) throw response.error;
  return response.data!;
}

export async function markInstanceError(sandboxId: string, errorMessage: string): Promise<void> {
  await backendApi.post('/platform/sandbox/mark-error', { sandbox_id: sandboxId, error_message: errorMessage }, { showErrors: false, timeout: 10000 });
}

/** Claim a free default computer for legacy paid users. */
export async function claimComputer(): Promise<any> {
  const response = await backendApi.post<any>('/platform/sandbox/claim-computer', {}, { timeout: 60000 });
  if (response.error) throw response.error;
  return response.data!;
}
