/**
 * Unified Billing React Query Hooks
 * 
 * Single hook for all billing data with proper invalidation
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  billingApi,
  type AccountState,
} from './api';

// Re-export types for convenience
export type {
  AccountState,
};

// =============================================================================
// QUERY KEYS - Single key for all billing state
// =============================================================================

const accountStateKeys = {
  all: ['account-state'] as const,
  state: () => [...accountStateKeys.all, 'state'] as const,
};

// =============================================================================
// UTILITY - Invalidation helper for mutations
// =============================================================================

function invalidateAccountState(queryClient: ReturnType<typeof useQueryClient>) {
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

export function useCancelScheduledChange() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApi.cancelScheduledChange(),
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
  revenuecat_product_id?: string | null;
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
