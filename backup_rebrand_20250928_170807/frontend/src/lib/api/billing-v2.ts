import { backendApi } from "../api-client";

export interface CreditBalance {
  balance: number;
  expiring_credits: number;
  non_expiring_credits: number;
  tier: string;
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
  price_id: string;
  subscription: {
    id: string;
    status: string;
    price_id: string;
    current_period_end: string;
    cancel_at?: string;
    canceled_at?: string;
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

export interface BillingStatus {
  can_run: boolean;
  balance: number;
  tier: string;
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
  price_id: string;
  success_url: string;
  cancel_url: string;
}

export interface CreateCheckoutSessionResponse {
  checkout_url?: string;
  success?: boolean;
  subscription_id?: string;
  message?: string;
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

export const billingApiV2 = {
  async getSubscription() {
    const response = await backendApi.get<SubscriptionInfo>('/billing/subscription');
    if (response.error) throw response.error;
    return response.data!;
  },

  async checkBillingStatus() {
    const response = await backendApi.post<BillingStatus>('/billing/check');
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
    return response.data!;
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
  }
};

export const getSubscription = () => billingApiV2.getSubscription();
export const checkBillingStatus = () => billingApiV2.checkBillingStatus();
export const getCreditBalance = () => billingApiV2.getCreditBalance();
export const deductTokenUsage = (usage: TokenUsage) => billingApiV2.deductTokenUsage(usage);
export const createCheckoutSession = (request: CreateCheckoutSessionRequest) => 
  billingApiV2.createCheckoutSession(request);
export const createPortalSession = (request: CreatePortalSessionRequest) => 
  billingApiV2.createPortalSession(request);
export const cancelSubscription = (feedback?: string) => 
  billingApiV2.cancelSubscription(feedback ? { feedback } : undefined);
export const reactivateSubscription = () => billingApiV2.reactivateSubscription();
export const purchaseCredits = (request: PurchaseCreditsRequest) => 
  billingApiV2.purchaseCredits(request);
export const getTransactions = (limit?: number, offset?: number) => 
  billingApiV2.getTransactions(limit, offset);
export const getUsageHistory = (days?: number) => billingApiV2.getUsageHistory(days);
export const triggerTestRenewal = () => billingApiV2.triggerTestRenewal();
export const getTrialStatus = () => billingApiV2.getTrialStatus();
export const startTrial = (request: TrialStartRequest) => billingApiV2.startTrial(request);
export const createTrialCheckout = (request: TrialCheckoutRequest) => 
  billingApiV2.createTrialCheckout(request);
export const cancelTrial = () => billingApiV2.cancelTrial(); 