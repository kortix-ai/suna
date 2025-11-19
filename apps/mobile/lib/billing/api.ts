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
}

export interface SubscriptionInfo {
  status: string;
  plan_name: string;
  display_plan_name?: string;
  tier_key: string;
  billing_period?: 'monthly' | 'yearly' | 'yearly_commitment' | null;
  provider?: 'stripe' | 'revenuecat';
  revenuecat_customer_id?: string | null;
  revenuecat_subscription_id?: string | null;
  revenuecat_product_id?: string | null;
  subscription: {
    id: string;
    status: string;
    tier_key: string;
    current_period_end: string | number;
    cancel_at?: string | number | null;
    canceled_at?: string | number | null;
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

export interface CreateCheckoutSessionRequest {
  tier_key: string;  // Backend tier key like 'tier_2_20', 'free', etc.
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
  fe_checkout_url?: string;  // Kortix-branded embedded checkout
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

export interface CommitmentInfo {
  has_commitment: boolean;
  can_cancel: boolean;
  commitment_type?: string | null;
  months_remaining?: number | null;
  commitment_end_date?: string | null;
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

export interface ScheduledChangesResponse {
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
    console.log('🔄 Fetching subscription data...');
    const data = await fetchApi<SubscriptionInfo>('/billing/subscription');
    console.log('✅ Subscription data received:', {
      provider: data.provider,
      revenuecat_product_id: data.revenuecat_product_id,
      revenuecat_subscription_id: data.revenuecat_subscription_id,
      tier_key: data.tier_key,
      status: data.status
    });
    return data;
  },

  async checkBillingStatus(): Promise<BillingStatus> {
    return fetchApi<BillingStatus>('/billing/check-status', {
      method: 'GET',
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

  async getSubscriptionCommitment(subscriptionId: string): Promise<CommitmentInfo> {
    return fetchApi(`/billing/subscription-commitment/${subscriptionId}`);
  },

  async scheduleDowngrade(request: ScheduleDowngradeRequest): Promise<ScheduleDowngradeResponse> {
    return fetchApi('/billing/schedule-downgrade', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  },

  async getScheduledChanges(): Promise<ScheduledChangesResponse> {
    return fetchApi('/billing/scheduled-changes');
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

