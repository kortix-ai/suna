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

// Export billingKeys as alias for accountStateKeys for backward compatibility
export const billingKeys = accountStateKeys;
