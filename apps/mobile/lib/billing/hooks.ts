/**
 * Billing React Query Hooks
 * 
 * React Query hooks for billing data fetching and mutations
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseQueryOptions,
} from '@tanstack/react-query';
import {
  billingApi,
  type SubscriptionInfo,
  type CreditBalance,
  type BillingStatus,
  type CreateCheckoutSessionRequest,
  type CreateCheckoutSessionResponse,
  type CommitmentInfo,
  type ScheduleDowngradeRequest,
  type ScheduleDowngradeResponse,
  type ScheduledChangesResponse,
  type CancelScheduledChangeResponse,
  type CreatePortalSessionRequest,
  type CreatePortalSessionResponse,
  type CancelSubscriptionRequest,
} from './api';
import {
  usageApi,
  type ThreadUsageResponse,
  type UseThreadUsageParams,
} from './usage-api';

// Re-export types for convenience
export type {
  SubscriptionInfo,
  CreditBalance,
  BillingStatus,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
  CommitmentInfo,
  ScheduleDowngradeRequest,
  ScheduleDowngradeResponse,
  ScheduledChangesResponse,
  CancelScheduledChangeResponse,
  CreatePortalSessionRequest,
  CreatePortalSessionResponse,
  CancelSubscriptionRequest,
  ThreadUsageResponse,
  UseThreadUsageParams,
};

// ============================================================================
// Query Keys
// ============================================================================

export const billingKeys = {
  all: ['billing'] as const,
  subscription: () => [...billingKeys.all, 'subscription'] as const,
  balance: () => [...billingKeys.all, 'balance'] as const,
  status: () => [...billingKeys.all, 'status'] as const,
  scheduledChanges: () => [...billingKeys.all, 'scheduled-changes'] as const,
  threadUsage: (params: UseThreadUsageParams) => [...billingKeys.all, 'thread-usage', params] as const,
};

// ============================================================================
// Query Hooks
// ============================================================================

export function useSubscription(options?: {
  enabled?: boolean;
  staleTime?: number;
  refetchOnMount?: boolean;
  refetchOnWindowFocus?: boolean;
}) {
  return useQuery<SubscriptionInfo>({
    queryKey: billingKeys.subscription(),
    queryFn: () => billingApi.getSubscription(),
    staleTime: 1000 * 60 * 10,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: true,
    ...options,
  });
}

export function useCreditBalance(
  options?: Omit<UseQueryOptions<CreditBalance, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery<CreditBalance>({
    queryKey: billingKeys.balance(),
    queryFn: () => billingApi.getCreditBalance(),
    staleTime: 1000 * 60 * 5, // 5 minutes - increased from 30 seconds
    gcTime: 1000 * 60 * 10, // 10 minutes cache time
    refetchOnWindowFocus: false, // Don't refetch on window focus
    refetchOnMount: false, // Don't refetch on mount if data is fresh
    refetchOnReconnect: true, // Only refetch on reconnect
    ...options,
  });
}

export function useBillingStatus(
  options?: Omit<UseQueryOptions<BillingStatus, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery<BillingStatus>({
    queryKey: billingKeys.status(),
    queryFn: () => billingApi.checkBillingStatus(),
    staleTime: 1000 * 60 * 5, // 5 minutes - increased from 30 seconds
    gcTime: 1000 * 60 * 10, // 10 minutes cache time
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    ...options,
  });
}

// ============================================================================
// Mutation Hooks
// ============================================================================

export function useCreateCheckoutSession() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: CreateCheckoutSessionRequest) => 
      billingApi.createCheckoutSession(request),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      // Mobile will handle opening URL in Linking
      return data;
    },
  });
}

export function useCancelSubscription() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request?: CancelSubscriptionRequest) => billingApi.cancelSubscription(request),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
      // Note: Mobile doesn't have toast, so we'll handle success in components
    },
  });
}

export function useCreatePortalSession() {
  return useMutation({
    mutationFn: (params: CreatePortalSessionRequest) => billingApi.createPortalSession(params),
    onSuccess: (data) => {
      // Mobile will handle opening URL in Linking
      return data;
    },
  });
}

export function useSubscriptionCommitment(
  subscriptionId?: string,
  options?: Omit<UseQueryOptions<CommitmentInfo, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery<CommitmentInfo>({
    queryKey: [...billingKeys.subscription(), 'commitment', subscriptionId || ''],
    queryFn: () => billingApi.getSubscriptionCommitment(subscriptionId!),
    enabled: (options?.enabled ?? true) && !!subscriptionId,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
    ...options,
  });
}

export function useScheduleDowngrade() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: ScheduleDowngradeRequest) => billingApi.scheduleDowngrade(request),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      queryClient.invalidateQueries({ queryKey: billingKeys.scheduledChanges() });
      // Note: Mobile doesn't have toast, so we'll handle success in components
    },
  });
}

export function useScheduledChanges(
  options?: Omit<UseQueryOptions<ScheduledChangesResponse, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery<ScheduledChangesResponse>({
    queryKey: billingKeys.scheduledChanges(),
    queryFn: () => billingApi.getScheduledChanges(),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: true,
    ...options,
  });
}

export function useCancelScheduledChange() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApi.cancelScheduledChange(),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      queryClient.invalidateQueries({ queryKey: billingKeys.scheduledChanges() });
      // Note: Mobile doesn't have toast, so we'll handle success in components
    },
  });
}

export function useReactivateSubscription(
  options?: UseMutationOptions<
    { success: boolean; message: string },
    Error,
    void
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => billingApi.reactivateSubscription(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
    },
    ...options,
  });
}

export function useThreadUsage(params: UseThreadUsageParams) {
  const { enabled, ...queryParams } = params;
  return useQuery<ThreadUsageResponse>({
    queryKey: billingKeys.threadUsage(queryParams),
    queryFn: () => usageApi.getThreadUsage(queryParams),
    staleTime: 1000 * 30,
    gcTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    enabled: enabled ?? true,
  });
}
