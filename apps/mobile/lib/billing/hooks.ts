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
  type TrialStatus,
  type CreateCheckoutSessionRequest,
  type CreateCheckoutSessionResponse,
  type PurchaseCreditsRequest,
  type PurchaseCreditsResponse,
  type TrialStartRequest,
  type TrialStartResponse,
  type TrialCheckoutRequest,
  type TrialCheckoutResponse,
  type Transaction,
  type UsageHistory,
} from './api';

// ============================================================================
// Query Keys
// ============================================================================

export const billingKeys = {
  all: ['billing'] as const,
  subscription: () => [...billingKeys.all, 'subscription'] as const,
  creditBalance: () => [...billingKeys.all, 'credit-balance'] as const,
  billingStatus: () => [...billingKeys.all, 'status'] as const,
  trialStatus: () => [...billingKeys.all, 'trial-status'] as const,
  transactions: (limit?: number, offset?: number) =>
    [...billingKeys.all, 'transactions', { limit, offset }] as const,
  usageHistory: (days?: number) =>
    [...billingKeys.all, 'usage-history', { days }] as const,
};

// ============================================================================
// Query Hooks
// ============================================================================

export function useSubscription(
  options?: Omit<
    UseQueryOptions<SubscriptionInfo, Error>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: billingKeys.subscription(),
    queryFn: () => billingApi.getSubscription(),
    staleTime: 5 * 60 * 1000,
    ...options,
  });
}

export function useCreditBalance(
  options?: Omit<UseQueryOptions<CreditBalance, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: billingKeys.creditBalance(),
    queryFn: () => billingApi.getCreditBalance(),
    staleTime: 5 * 60 * 1000,
    ...options,
  });
}

export function useBillingStatus(
  options?: Omit<UseQueryOptions<BillingStatus, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: billingKeys.billingStatus(),
    queryFn: () => billingApi.checkBillingStatus(),
    staleTime: 1 * 60 * 1000,
    ...options,
  });
}

export function useTrialStatus(
  options?: Omit<UseQueryOptions<TrialStatus, Error>, 'queryKey' | 'queryFn'>
) {
  return useQuery({
    queryKey: billingKeys.trialStatus(),
    queryFn: () => billingApi.getTrialStatus(),
    staleTime: 5 * 60 * 1000,
    ...options,
  });
}

export function useTransactions(
  limit = 50,
  offset = 0,
  options?: Omit<
    UseQueryOptions<{ transactions: Transaction[]; count: number }, Error>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: billingKeys.transactions(limit, offset),
    queryFn: () => billingApi.getTransactions(limit, offset),
    ...options,
  });
}

export function useUsageHistory(
  days = 30,
  options?: Omit<
    UseQueryOptions<UsageHistory, Error>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: billingKeys.usageHistory(days),
    queryFn: () => billingApi.getUsageHistory(days),
    ...options,
  });
}

// ============================================================================
// Mutation Hooks
// ============================================================================

export function useCreateCheckout(
  options?: UseMutationOptions<
    CreateCheckoutSessionResponse,
    Error,
    CreateCheckoutSessionRequest
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreateCheckoutSessionRequest) =>
      billingApi.createCheckoutSession(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      queryClient.invalidateQueries({ queryKey: billingKeys.creditBalance() });
      queryClient.invalidateQueries({ queryKey: billingKeys.billingStatus() });
    },
    ...options,
  });
}

export function usePurchaseCredits(
  options?: UseMutationOptions<
    PurchaseCreditsResponse,
    Error,
    PurchaseCreditsRequest
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: PurchaseCreditsRequest) =>
      billingApi.purchaseCredits(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.creditBalance() });
      queryClient.invalidateQueries({ queryKey: billingKeys.billingStatus() });
    },
    ...options,
  });
}

export function useStartTrial(
  options?: UseMutationOptions<TrialStartResponse, Error, TrialStartRequest>
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: TrialStartRequest) => billingApi.startTrial(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.all });
    },
    ...options,
  });
}

export function useCreateTrialCheckout(
  options?: UseMutationOptions<
    TrialCheckoutResponse,
    Error,
    TrialCheckoutRequest
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: TrialCheckoutRequest) =>
      billingApi.createTrialCheckout(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.all });
    },
    ...options,
  });
}

export function useCancelTrial(
  options?: UseMutationOptions<
    { success: boolean; message: string; subscription_status: string },
    Error,
    void
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => billingApi.cancelTrial(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.all });
    },
    ...options,
  });
}

export function useCancelSubscription(
  options?: UseMutationOptions<
    { success: boolean; cancel_at: number; message: string },
    Error,
    string | undefined
  >
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (feedback?: string) => billingApi.cancelSubscription(feedback ? { feedback } : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
    },
    ...options,
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

