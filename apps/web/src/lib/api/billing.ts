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
    concurrent_sessions?: {
      active: number;
      limit: number;
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
  can_add_instances?: boolean;
  // Billing v2 — present for accounts on the new per-seat plan.
  billing_model?: 'legacy' | 'per_seat';
  seats?: {
    count: number;
    price_per_seat_usd: number;
    typical_compute_budget_per_seat_usd: number;
    typical_llm_budget_per_seat_usd: number;
  };
  usage_this_period?: {
    compute_usd: number;
    llm_usd: number;
    total_usd: number;
    period_start: string | null;
    period_end: string | null;
  } | null;
  _cache?: {
    cached: boolean;
    ttl_seconds?: number;
    local_mode?: boolean;
  };
}

// =============================================================================
// MUTATION REQUEST/RESPONSE TYPES
// =============================================================================

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
   *
   * Pass `accountId` to scope the fetch to a specific account the user is a
   * member of (e.g. on /accounts/[id] pages). Without it, the backend uses the
   * user's first membership — fine for global surfaces like the user menu and
   * upgrade dialog, but wrong for the per-account billing page.
   */
  async getAccountState(skipCache = false, accountId?: string): Promise<AccountState> {
    const search = new URLSearchParams();
    if (skipCache) search.set('skip_cache', 'true');
    if (accountId) search.set('account_id', accountId);
    const query = search.toString();
    const params = query ? `?${query}` : '';
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

  async purchaseCredits(request: PurchaseCreditsRequest, accountId?: string) {
    const response = await backendApi.post<PurchaseCreditsResponse>(
      '/billing/purchase-credits',
      accountId ? { ...request, account_id: accountId } : request
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
};

// =============================================================================
// CONVENIENCE EXPORTS
// =============================================================================

export const createCheckoutSession = (request: CreateCheckoutSessionRequest) => 
  billingApi.createCheckoutSession(request);

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
