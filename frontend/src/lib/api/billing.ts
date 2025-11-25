import { backendApi } from "../api-client";

export interface BillingStatus {
  status: string;
  can_use: boolean;
  reason?: string;
}

export interface BillingStatusResponse {
  can_run: boolean;
  message: string;
  subscription: {
    tier_key: string;
    plan_name: string;
    minutes_limit?: number;
  };
}

export interface Model {
  id: string;
  display_name: string;
  short_name?: string;
  requires_subscription?: boolean;
  is_available?: boolean;
  input_cost_per_million_tokens?: number | null;
  output_cost_per_million_tokens?: number | null;
  max_tokens?: number | null;
  context_window?: number;
  capabilities?: string[];
  recommended?: boolean;
  priority?: number;
}

export interface AvailableModelsResponse {
  models: Model[];
  subscription_tier: string;
  total_models: number;
}

export interface CreditBalance {
  balance: number;
  expiring_credits: number;
  non_expiring_credits: number;
  daily_credits?: number;
  tier: string;
  next_credit_grant?: string;
  can_purchase_credits: boolean;
  breakdown?: {
    expiring: number;
    non_expiring: number;
    daily?: number;
    total: number;
  };
  daily_credits_info?: {
    enabled: boolean;
    daily_amount: number;
    refresh_interval_hours: number;
    current_balance: number;
    last_refresh?: string;
    next_refresh_at?: string;
    seconds_until_refresh?: number;
  };
  lifetime_granted?: number;
  lifetime_purchased?: number;
  lifetime_used?: number;
}

export interface SubscriptionInfo {
  status: string;
  plan_name: string;
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
  };
  credits: {
    balance: number;
    tier_credits: number;
    lifetime_granted: number;
    lifetime_purchased: number;
    lifetime_used: number;
    can_purchase_credits: boolean;
  };
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

export interface CreateCheckoutSessionRequest {
  tier_key: string;  // Backend tier key like 'tier_2_20', 'free', etc.
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

export interface TestRenewalResponse {
  success: boolean;
  message?: string;
  credits_granted?: number;
  new_balance?: number;
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

export interface SubscriptionCancellationStatus {
  has_subscription: boolean;
  subscription_id?: string;
  is_cancelled: boolean;
  cancel_at: number | null;
  cancel_at_period_end: boolean;
  canceled_at?: number | null;
  current_period_end: number | string | null;
  status: string | null;
  cancellation_details?: any;
  error?: string;
}

// Legacy interface for backward compatibility
export interface SubscriptionStatus {
  status: string; // Includes 'active', 'trialing', 'past_due', 'scheduled_downgrade', 'no_subscription'
  plan_name?: string;
  tier_key?: string;  // Backend tier key like 'tier_2_20', 'free', etc.
  current_period_end?: string; // ISO datetime string
  cancel_at_period_end?: boolean;
  trial_end?: string; // ISO datetime string
  trial_status?: string; // Trial status: 'active', 'expired', 'cancelled', 'used', 'converted'
  trial_ends_at?: string; // ISO datetime string
  is_trial?: boolean;
  minutes_limit?: number;
  cost_limit?: number;
  current_usage?: number;
  // Fields for scheduled changes
  has_schedule?: boolean;
  scheduled_plan_name?: string;
  scheduled_tier_key?: string;  // Backend tier key for scheduled change
  scheduled_change_date?: string; // ISO datetime string
  // Subscription data for frontend components
  subscription_id?: string;
  subscription?: {
    id: string;
    status: string;
    cancel_at_period_end: boolean;
    cancel_at?: number; // timestamp for yearly commitment cancellations
    current_period_end: number; // timestamp
  };
  // Credit information
  credit_balance?: number;
  can_purchase_credits?: boolean;
  tier?: {
    name: string;
    credits: number;
    can_purchase_credits: boolean;
    models?: string[];
    project_limit?: number;
  };
}

// Interface for user subscription details from Stripe
export interface UserSubscriptionResponse {
  subscription?: {
    id: string;
    status: string;
    current_period_end: number;
    current_period_start: number;
    cancel_at_period_end: boolean;
    cancel_at?: number;
    items: {
      data: Array<{
        id: string;
        price: {
          id: string;
          unit_amount: number;
          currency: string;
          recurring: {
            interval: string;
            interval_count: number;
          };
        };
        quantity: number;
      }>;
    };
    metadata: {
      [key: string]: string;
    };
  };
  tier_key?: string;  // Backend tier key
  plan_name?: string;
  status?: string;
  has_schedule?: boolean;
  scheduled_tier_key?: string;  // Backend tier key for scheduled change
  current_period_end?: number;
  current_period_start?: number;
  cancel_at_period_end?: boolean;
  cancel_at?: number;
  customer_email?: string;
  usage?: {
    total_usage: number;
    limit: number;
  };
}

export const billingApi = {
  async getSubscription() {
    const response = await backendApi.get<SubscriptionInfo>('/billing/subscription');
    if (response.error) throw response.error;
    return response.data!;
  },

  async checkBillingStatus() {
    const response = await backendApi.get<BillingStatusResponse>('/billing/check-status');
    if (response.error) throw response.error;
    return response.data!;
  },

  async getCreditBalance() {
    const response = await backendApi.get<CreditBalance>('/billing/balance');
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
    
    // Transform response to match expected format
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

  async triggerTestRenewal() {
    const response = await backendApi.post<TestRenewalResponse>('/billing/test/trigger-renewal');
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

  async getSubscriptionCancellationStatus() {
    const response = await backendApi.get<SubscriptionCancellationStatus>('/billing/subscription-cancellation-status');
    if (response.error) throw response.error;
    return response.data!;
  },

  async getSubscriptionCommitment(subscriptionId: string) {
    const response = await backendApi.get<CommitmentInfo>(`/billing/subscription-commitment/${subscriptionId}`);
    if (response.error) throw response.error;
    return response.data!;
  },

  async getAvailableModels() {
    const response = await backendApi.get<AvailableModelsResponse>('/billing/available-models', {
      showErrors: false,
    });
    if (response.error && response.error.status !== 401) {
      throw response.error;
    }
    if (response.error) {
      return { models: [], subscription_tier: 'none', total_models: 0 };
    }
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

  async getScheduledChanges() {
    const response = await backendApi.get<ScheduledChangesResponse>(
      '/billing/scheduled-changes'
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
  }
};

export const getSubscription = () => billingApi.getSubscription();
export const checkBillingStatus = () => billingApi.checkBillingStatus();
export const getCreditBalance = () => billingApi.getCreditBalance();
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
export const triggerTestRenewal = () => billingApi.triggerTestRenewal();
export const getTrialStatus = () => billingApi.getTrialStatus();
export const startTrial = (request: TrialStartRequest) => billingApi.startTrial(request);
export const createTrialCheckout = (request: TrialCheckoutRequest) => 
  billingApi.createTrialCheckout(request);
export const cancelTrial = () => billingApi.cancelTrial();
export const getSubscriptionCommitment = (subscriptionId: string) => 
  billingApi.getSubscriptionCommitment(subscriptionId);
export const getAvailableModels = () => billingApi.getAvailableModels(); 