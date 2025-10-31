/**
 * Billing API Client & Types
 * 
 * Core billing API functions and type definitions
 */

import { API_URL, getAuthHeaders } from '@/api/config';

// ============================================================================
// Type Definitions
// ============================================================================

export interface CreditBalance {
  balance: number;
  expiring_credits: number;
  non_expiring_credits: number;
  tier: string;
  tier_display_name?: string;
  next_credit_grant?: string;
  can_purchase_credits: boolean;
  breakdown?: {
    expiring: number;
    non_expiring: number;
    total: number;
  };
  lifetime_granted?: number;
  lifetime_purchased?: number;
  lifetime_used?: number;
  is_trial?: boolean;
  trial_status?: string;
  trial_ends_at?: string;
}

export interface SubscriptionInfo {
  status: string;
  plan_name: string;
  display_plan_name?: string;
  price_id: string;
  is_trial?: boolean;
  trial_status?: string;
  trial_ends_at?: string;
  subscription: {
    id: string | null;
    status: string;
    price_id: string;
    current_period_end: string | null;
    cancel_at?: string;
    canceled_at?: string;
    is_trial?: boolean;
    trial_tier?: string;
    trial_end?: string;
    trial_ends_at?: string;
    metadata?: any;
    created?: string | null;
    cancel_at_period_end?: boolean;
  } | null;
  tier: {
    name: string;
    credits: number;
    display_name?: string;
  };
  credits: {
    balance: number;
    tier_credits: number;
    lifetime_granted: number;
    lifetime_purchased: number;
    lifetime_used: number;
    can_purchase_credits: boolean;
  };
  subscription_id?: string | null;
  credit_balance?: number;
  current_usage?: number;
  cost_limit?: number;
  can_purchase_credits?: boolean;
}

export interface BillingStatus {
  can_run: boolean;
  balance: number;
  tier: string;
  message: string;
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

export interface CreateCheckoutSessionRequest {
  price_id: string;
  success_url: string;
  cancel_url: string;
  commitment_type?: 'monthly' | 'yearly' | 'yearly_commitment';
}

export interface CreateCheckoutSessionResponse {
  checkout_url?: string;
  fe_checkout_url?: string;  // Kortix-branded embedded checkout
  url?: string;
  session_id?: string;
  client_secret?: string;
  success?: boolean;
  subscription_id?: string;
  message?: string;
  status?: string;
}

export interface PurchaseCreditsRequest {
  amount: number;
  success_url: string;
  cancel_url: string;
}

export interface PurchaseCreditsResponse {
  checkout_url: string;
}

export interface TrialStartRequest {
  success_url: string;
  cancel_url: string;
}

export interface TrialStartResponse {
  checkout_url: string;
  fe_checkout_url?: string; 
  session_id: string;
  client_secret?: string;  // For embedded checkout
}

export interface TrialCheckoutRequest {
  success_url: string;
  cancel_url: string;
}

export interface TrialCheckoutResponse {
  checkout_url: string;
  session_id: string;
}

export interface CancelSubscriptionRequest {
  feedback?: string;
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

// ============================================================================
// API Helper
// ============================================================================

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
    const error = await response.json().catch(() => ({ message: response.statusText }));
    console.error('❌ Billing API Error:', {
      endpoint,
      status: response.status,
      error,
    });
    throw new Error(error.detail?.message || error.message || `HTTP ${response.status}`);
  }

  return response.json();
}

// ============================================================================
// API Functions
// ============================================================================

export const billingApi = {
  async getSubscription(): Promise<SubscriptionInfo> {
    // console.log('🔄 Fetching subscription data...');
    const data = await fetchApi<SubscriptionInfo>('/billing/subscription');
    // console.log('✅ Subscription data received:', JSON.stringify(data, null, 2));
    return data;
  },

  async checkBillingStatus(): Promise<BillingStatus> {
    return fetchApi<BillingStatus>('/billing/check', {
      method: 'POST',
    });
  },

  async getCreditBalance(): Promise<CreditBalance> {
    // console.log('🔄 Fetching credit balance...');
    const data = await fetchApi<CreditBalance>('/billing/balance');
    // console.log('✅ Credit balance received:', JSON.stringify(data, null, 2));
    return data;
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

  async purchaseCredits(
    request: PurchaseCreditsRequest
  ): Promise<PurchaseCreditsResponse> {
    return fetchApi<PurchaseCreditsResponse>('/billing/purchase-credits', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  async getTrialStatus(): Promise<TrialStatus> {
    // console.log('🔄 Fetching trial status...');
    const data = await fetchApi<TrialStatus>('/billing/trial/status');
    // console.log('✅ Trial status received:', JSON.stringify(data, null, 2));
    return data;
  },

  async startTrial(request: TrialStartRequest): Promise<TrialStartResponse> {
    return fetchApi<TrialStartResponse>('/billing/trial/start', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  async createTrialCheckout(
    request: TrialCheckoutRequest
  ): Promise<TrialCheckoutResponse> {
    return fetchApi<TrialCheckoutResponse>('/billing/trial/create-checkout', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  async cancelTrial(): Promise<{
    success: boolean;
    message: string;
    subscription_status: string;
  }> {
    return fetchApi('/billing/trial/cancel', {
      method: 'POST',
    });
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

  async getTransactions(
    limit = 50,
    offset = 0
  ): Promise<{ transactions: Transaction[]; count: number }> {
    return fetchApi(
      `/billing/transactions?limit=${limit}&offset=${offset}`
    );
  },

  async getUsageHistory(days = 30): Promise<UsageHistory> {
    return fetchApi(`/billing/usage-history?days=${days}`);
  },
};

