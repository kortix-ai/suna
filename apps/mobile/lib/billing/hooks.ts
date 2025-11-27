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
