/**
 * Unified Billing API Client & Types
 * 
 * Single endpoint for all billing state
 */

import { API_URL, getAuthHeaders } from '@/api/config';

// =============================================================================
// UNIFIED ACCOUNT STATE
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
// MUTATION REQUEST/RESPONSE TYPES
// =============================================================================

export interface CreateCheckoutSessionRequest {
  tier_key: string;
  success_url: string;
  cancel_url: string;
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
  fe_checkout_url?: string;
  effective_date?: string;
  message?: string;
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

export interface CreatePortalSessionRequest {
  return_url: string;
}

export interface CreatePortalSessionResponse {
  portal_url: string;
}

export interface CancelSubscriptionRequest {
  feedback?: string;
}

// =============================================================================
// API Helper
// =============================================================================

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = await getAuthHeaders();
  
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: response.statusText }));
    
    // Only log non-auth errors (401/403 are expected when not authenticated)
    if (response.status !== 401 && response.status !== 403) {
      console.error('❌ Billing API Error:', {
        endpoint,
        status: response.status,
        error: errorData,
      });
    }
    
    const errorMessage = errorData.detail?.message || errorData.detail || errorData.message || response.statusText;
    throw new Error(`HTTP ${response.status}: ${errorMessage}`);
  }

  return response.json();
}

// =============================================================================
// API Functions
// =============================================================================

export const billingApi = {
  /**
   * Get unified account state - single source of truth for all billing data
   */
  async getAccountState(skipCache = false): Promise<AccountState> {
    const params = skipCache ? '?skip_cache=true' : '';
    return fetchApi<AccountState>(`/billing/account-state${params}`);
  },

  async createCheckoutSession(
    request: CreateCheckoutSessionRequest
  ): Promise<CreateCheckoutSessionResponse> {
    return fetchApi<CreateCheckoutSessionResponse>(
      '/billing/create-checkout-session',
      {
        method: 'POST',
        body: JSON.stringify(request),
      }
    );
  },

  async cancelSubscription(
    request?: CancelSubscriptionRequest
  ): Promise<{ success: boolean; cancel_at: number; message: string }> {
    return fetchApi('/billing/cancel-subscription', {
      method: 'POST',
      body: JSON.stringify(request || {}),
    });
  },

  async reactivateSubscription(): Promise<{
    success: boolean;
    message: string;
  }> {
    return fetchApi('/billing/reactivate-subscription', {
      method: 'POST',
    });
  },

  async scheduleDowngrade(request: ScheduleDowngradeRequest): Promise<ScheduleDowngradeResponse> {
    return fetchApi('/billing/schedule-downgrade', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  async cancelScheduledChange(): Promise<CancelScheduledChangeResponse> {
    return fetchApi('/billing/cancel-scheduled-change', {
      method: 'POST',
    });
  },

  async createPortalSession(request: CreatePortalSessionRequest): Promise<CreatePortalSessionResponse> {
    return fetchApi('/billing/create-portal-session', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },
};

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
  allowedModels: (state: AccountState | undefined) => 
    state?.models.filter(m => m.allowed) ?? [],
  isModelAllowed: (state: AccountState | undefined, modelId: string) =>
    state?.models.find(m => m.id === modelId)?.allowed ?? false,
  scheduledChange: (state: AccountState | undefined) => state?.subscription.scheduled_change,
  hasScheduledChange: (state: AccountState | undefined) => 
    state?.subscription.has_scheduled_change ?? false,
  canPurchaseCredits: (state: AccountState | undefined) => 
    state?.subscription.can_purchase_credits ?? false,
  dailyCreditsInfo: (state: AccountState | undefined) => state?.credits.daily_refresh,
};
