/**
 * Unified Billing React Query Hooks
 * 
 * Single hook for all billing data with proper invalidation
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import {
  billingApi,
  accountStateSelectors,
  type AccountState,
  type CreateCheckoutSessionRequest,
  type CreateCheckoutSessionResponse,
  type ScheduleDowngradeRequest,
  type ScheduleDowngradeResponse,
  type CancelScheduledChangeResponse,
  type CreatePortalSessionRequest,
  type CreatePortalSessionResponse,
  type CancelSubscriptionRequest,
  type PurchaseCreditsRequest,
  type TokenUsage,
} from './api';

// Re-export types for convenience
export type {
  AccountState,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
  ScheduleDowngradeRequest,
  ScheduleDowngradeResponse,
  CancelScheduledChangeResponse,
  CreatePortalSessionRequest,
  CreatePortalSessionResponse,
  CancelSubscriptionRequest,
};

// Re-export selectors
export { accountStateSelectors };

// =============================================================================
// QUERY KEYS - Single key for all billing state
// =============================================================================

export const accountStateKeys = {
  all: ['account-state'] as const,
  state: () => [...accountStateKeys.all, 'state'] as const,
};

// =============================================================================
// UTILITY - Invalidation helper for mutations
// =============================================================================

export function invalidateAccountState(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: accountStateKeys.state() });
}

// Don't retry on auth errors (401/403)
const shouldRetry = (failureCount: number, error: Error) => {
  const message = error.message || '';
  if (message.includes('401') || message.includes('403') || message.includes('authentication')) {
    return false;
  }
  return failureCount < 2;
};

// =============================================================================
// MAIN HOOK - Single query for all billing data
// =============================================================================

interface UseAccountStateOptions {
  enabled?: boolean;
  staleTime?: number;
  refetchOnMount?: boolean;
  refetchOnWindowFocus?: boolean;
}

/**
 * Unified hook for all account billing state.
 * 
 * The data is cached for 10 minutes and only refetched when:
 * - A mutation occurs (upgrade, downgrade, purchase, etc.)
 * - User explicitly refreshes
 * - Agent run completes (credits deducted)
 */
export function useAccountState(options?: UseAccountStateOptions) {
  const enabled = options?.enabled ?? true;
  
  return useQuery<AccountState>({
    queryKey: accountStateKeys.state(),
    queryFn: () => billingApi.getAccountState(),
    enabled,
    staleTime: options?.staleTime ?? 1000 * 60 * 10, // 10 minutes
    gcTime: 1000 * 60 * 15, // 15 minutes
    refetchOnWindowFocus: options?.refetchOnWindowFocus ?? false,
    refetchOnMount: options?.refetchOnMount ?? false,
    refetchOnReconnect: true,
    retry: enabled ? shouldRetry : false,
  });
}

// =============================================================================
// MUTATION HOOKS - All invalidate account state after success
// =============================================================================

export function useCreateCheckoutSession() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: CreateCheckoutSessionRequest) => 
      billingApi.createCheckoutSession(request),
    onSuccess: (data) => {
      if (data.status === 'upgraded' || data.status === 'updated') {
        invalidateAccountState(queryClient);
      }
      return data;
    },
  });
}

export function useCancelSubscription() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request?: CancelSubscriptionRequest) => billingApi.cancelSubscription(request),
    onSuccess: () => {
      invalidateAccountState(queryClient);
    },
  });
}

export function useCreatePortalSession() {
  return useMutation({
    mutationFn: (params: CreatePortalSessionRequest) => billingApi.createPortalSession(params),
  });
}

export function useScheduleDowngrade() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: ScheduleDowngradeRequest) => billingApi.scheduleDowngrade(request),
    onSuccess: () => {
      invalidateAccountState(queryClient);
    },
  });
}

export function useCancelScheduledChange() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApi.cancelScheduledChange(),
    onSuccess: () => {
      invalidateAccountState(queryClient);
    },
  });
}

export function useReactivateSubscription() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => billingApi.reactivateSubscription(),
    onSuccess: () => {
      invalidateAccountState(queryClient);
    },
  });
}

// =============================================================================
// BACKWARD COMPATIBILITY HOOKS - Wrappers for BillingContext
// =============================================================================

// Types matching what BillingContext expects
export interface SubscriptionInfo {
  status: string;
  plan_name: string;
  tier_key: string;
  billing_period: 'monthly' | 'yearly' | 'yearly_commitment' | null;
  provider: 'stripe' | 'revenuecat' | 'local';
  subscription: {
    id: string;
    status: string;
    tier_key: string;
    current_period_end: number;
    cancel_at: string | null;
    cancel_at_period_end: boolean;
  } | null;
  tier: {
    name: string;
    display_name: string;
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
  is_trial: boolean;
  trial_status: string | null;
  has_scheduled_change: boolean;
  revenuecat_product_id?: string | null; // Optional for RevenueCat compatibility
}

export interface CreditBalance {
  balance: number;
  expiring_credits: number;
  non_expiring_credits: number;
  tier: string;
  can_purchase_credits: boolean;
}

export interface BillingStatus {
  can_run: boolean;
  has_credits: boolean;
  credits_remaining: number;
}

// Export billingKeys as alias for accountStateKeys for backward compatibility
export const billingKeys = accountStateKeys;

// Transform AccountState to SubscriptionInfo
function transformToSubscriptionInfo(state: AccountState | undefined): SubscriptionInfo | undefined {
  if (!state) return undefined;
  
  // Get revenuecat_product_id from account state if available (for RevenueCat provider)
  const revenuecatProductId = (state as any).subscription?.revenuecat_product_id || 
                               (state as any).revenuecat_product_id || 
                               null;
  
  return {
    status: state.subscription.status,
    plan_name: state.subscription.tier_display_name,
    tier_key: state.subscription.tier_key,
    billing_period: state.subscription.billing_period,
    provider: state.subscription.provider,
    subscription: state.subscription.subscription_id ? {
      id: state.subscription.subscription_id,
      status: state.subscription.status,
      tier_key: state.subscription.tier_key,
      current_period_end: state.subscription.current_period_end || 0,
      cancel_at: state.subscription.cancellation_effective_date || null,
      cancel_at_period_end: state.subscription.cancel_at_period_end,
    } : null,
    tier: {
      name: state.tier.name,
      display_name: state.tier.display_name,
      credits: state.tier.monthly_credits,
    },
    credits: {
      balance: state.credits.total,
      tier_credits: state.tier.monthly_credits,
      lifetime_granted: 0,
      lifetime_purchased: 0,
      lifetime_used: 0,
      can_purchase_credits: state.subscription.can_purchase_credits,
    },
    is_trial: state.subscription.is_trial,
    trial_status: state.subscription.trial_status,
    has_scheduled_change: state.subscription.has_scheduled_change,
    // Add revenuecat_product_id for RevenueCat compatibility
    revenuecat_product_id: revenuecatProductId,
  };
}

// Transform AccountState to CreditBalance
function transformToCreditBalance(state: AccountState | undefined): CreditBalance | undefined {
  if (!state) return undefined;
  
  return {
    balance: state.credits.total,
    expiring_credits: state.credits.daily + state.credits.monthly,
    non_expiring_credits: state.credits.extra,
    tier: state.subscription.tier_key,
    can_purchase_credits: state.subscription.can_purchase_credits,
  };
}

// Transform AccountState to BillingStatus
function transformToBillingStatus(state: AccountState | undefined): BillingStatus | undefined {
  if (!state) return undefined;
  
  return {
    can_run: state.credits.can_run,
    has_credits: state.credits.total > 0,
    credits_remaining: state.credits.total,
  };
}

interface UseSubscriptionOptions {
  enabled?: boolean;
}

interface UseCreditBalanceOptions {
  enabled?: boolean;
}

interface UseBillingStatusOptions {
  enabled?: boolean;
}

/**
 * Backward compatibility hook for subscription data
 * Uses useAccountState internally and transforms the data
 */
export function useSubscription(options?: UseSubscriptionOptions) {
  const { data, isLoading, error, refetch, ...rest } = useAccountState({
    enabled: options?.enabled,
  });
  
  return {
    data: transformToSubscriptionInfo(data),
    isLoading,
    error,
    refetch,
    ...rest,
  };
}

/**
 * Backward compatibility hook for credit balance
 * Uses useAccountState internally and transforms the data
 */
export function useCreditBalance(options?: UseCreditBalanceOptions) {
  const { data, isLoading, error, refetch, ...rest } = useAccountState({
    enabled: options?.enabled,
  });
  
  return {
    data: transformToCreditBalance(data),
    isLoading,
    error,
    refetch,
    ...rest,
  };
}

/**
 * Backward compatibility hook for billing status
 * Uses useAccountState internally and transforms the data
 */
export function useBillingStatus(options?: UseBillingStatusOptions) {
  const { data, isLoading, error, refetch, ...rest } = useAccountState({
    enabled: options?.enabled,
  });
  
  return {
    data: transformToBillingStatus(data),
    isLoading,
    error,
    refetch,
    ...rest,
  };
}

// =============================================================================
// ADDITIONAL HOOKS
// =============================================================================

/**
 * Invalidate credits after purchase - helper function
 */
export function invalidateCreditsAfterPurchase(queryClient: ReturnType<typeof useQueryClient>) {
  invalidateAccountState(queryClient);
}

/**
 * Subscription commitment hook - placeholder for now
 */
export function useSubscriptionCommitment(
  subscriptionId: string | null | undefined,
  options?: { enabled?: boolean }
) {
  // For now, return commitment info from account state
  const { data: accountState } = useAccountState({ enabled: options?.enabled ?? !!subscriptionId });
  
  return {
    data: accountState?.subscription.commitment,
    isLoading: false,
    error: null,
    refetch: async () => {},
  };
}

/**
 * Scheduled changes hook - placeholder for now
 */
export function useScheduledChanges(options?: { enabled?: boolean }) {
  const { data: accountState } = useAccountState({ enabled: options?.enabled });
  
  return {
    data: accountState?.subscription.scheduled_change ? {
      scheduled_change: accountState.subscription.scheduled_change,
      has_scheduled_change: accountState.subscription.has_scheduled_change,
    } : null,
    isLoading: false,
    error: null,
    refetch: async () => {},
  };
}

// =============================================================================
// ADDITIONAL MUTATION HOOKS - Matching frontend
// =============================================================================

export function usePurchaseCredits() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: PurchaseCreditsRequest) => billingApi.purchaseCredits(request),
    onSuccess: (data) => {
      // Will redirect to checkout - invalidation happens on return via backend
      if (data.checkout_url) {
        // In mobile, handled by checkout functions
      }
      invalidateAccountState(queryClient);
    },
  });
}

export function useDeductTokenUsage() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (usage: TokenUsage) => billingApi.deductTokenUsage(usage),
    onSuccess: () => {
      invalidateAccountState(queryClient);
    },
  });
}

export function useSyncSubscription() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApi.syncSubscription(),
    onSuccess: () => {
      invalidateAccountState(queryClient);
    },
  });
}

// =============================================================================
// USAGE HISTORY & TRANSACTIONS
// =============================================================================

export function useUsageHistory(days = 30) {
  return useQuery({
    queryKey: [...accountStateKeys.all, 'usage-history', days],
    queryFn: () => billingApi.getUsageHistory(days),
    staleTime: 1000 * 60 * 10, // 10 minutes
  });
}

export function useTransactions(limit = 50, offset = 0) {
  return useQuery({
    queryKey: [...accountStateKeys.all, 'transactions', limit, offset],
    queryFn: () => billingApi.getTransactions(limit, offset),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

// =============================================================================
// TRIAL HOOKS
// =============================================================================

export function useTrialStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...accountStateKeys.all, 'trial'],
    queryFn: () => billingApi.getTrialStatus(),
    enabled: options?.enabled ?? true,
    staleTime: 1000 * 60 * 5,
  });
}

export function useStartTrial() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: { success_url: string; cancel_url: string }) => 
      billingApi.startTrial(request),
    onSuccess: (data) => {
      invalidateAccountState(queryClient);
      if (data.checkout_url) {
        // In mobile, handled by checkout functions
      }
    },
  });
}

export function useCancelTrial() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApi.cancelTrial(),
    onSuccess: (response) => {
      invalidateAccountState(queryClient);
    },
  });
}

// =============================================================================
// STREAMING VARIANT
// =============================================================================

export function useAccountStateWithStreaming(isStreaming: boolean = false) {
  return useQuery<AccountState>({
    queryKey: accountStateKeys.state(),
    queryFn: () => billingApi.getAccountState(),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchInterval: isStreaming ? 2 * 60 * 1000 : false, // 2 minutes if streaming
    refetchIntervalInBackground: false,
  });
}
