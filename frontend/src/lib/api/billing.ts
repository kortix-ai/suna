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
    recommended: boolean;
  }>;
  limits: {
    projects: {
      current: number;
      max: number;
      can_create: boolean;
      tier_name: string;
    };
    threads: {
      current: number;
      max: number;
      can_create: boolean;
      tier_name: string;
    };
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
    trigger_count: {
      scheduled: {
        current_count: number;
        limit: number;
        can_create: boolean;
      };
      app: {
        current_count: number;
        limit: number;
        can_create: boolean;
      };
      tier_name: string;
    };
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
// MUTATION REQUEST/RESPONSE TYPES
// =============================================================================

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  model: string;
  thread_id?: string;
  message_id?: string;
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
}

export interface CreateCheckoutSessionResponse {
  status:
    | 'upgraded'
    | 'downgrade_scheduled'
    | 'checkout_created'
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
    if (response.error && response.error.status !== 401) {
      throw response.error;
    }
    if (response.error) {
      // Return default state for unauthenticated users
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
          projects: {
            current: 0,
            max: 0,
            can_create: false,
            tier_name: 'none'
          },
          threads: {
            current: 0,
            max: 0,
            can_create: false,
            tier_name: 'none'
          },
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
          trigger_count: {
            scheduled: {
              current_count: 0,
              limit: 0,
              can_create: false
            },
            app: {
              current_count: 0,
              limit: 0,
              can_create: false
            },
            tier_name: 'none'
          }
        },
        tier: {
          name: 'none',
          display_name: 'No Plan',
          monthly_credits: 0,
          can_purchase_credits: false,
        },
      };
    }
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
  }
};

// =============================================================================
// CONVENIENCE EXPORTS
// =============================================================================

export const getAccountState = (skipCache?: boolean) => billingApi.getAccountState(skipCache);
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
