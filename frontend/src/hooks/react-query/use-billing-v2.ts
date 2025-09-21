import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  billingApiV2,
  CreateCheckoutSessionRequest,
  CreatePortalSessionRequest,
  PurchaseCreditsRequest,
  TokenUsage,
  CancelSubscriptionRequest,
} from '@/lib/api/billing-v2';

export const billingKeys = {
  all: ['billing'] as const,
  subscription: () => [...billingKeys.all, 'subscription'] as const,
  balance: () => [...billingKeys.all, 'balance'] as const,
  status: () => [...billingKeys.all, 'status'] as const,
  transactions: (limit?: number, offset?: number) => 
    [...billingKeys.all, 'transactions', { limit, offset }] as const,
  usageHistory: (days?: number) => 
    [...billingKeys.all, 'usage-history', { days }] as const,
};

export const useSubscription = (enabled = true) => {
  return useQuery({
    queryKey: billingKeys.subscription(),
    queryFn: () => billingApiV2.getSubscription(),
    staleTime: 1000 * 60,
    enabled,
  });
};

export const useCreditBalance = (enabled = true) => {
  return useQuery({
    queryKey: billingKeys.balance(),
    queryFn: () => billingApiV2.getCreditBalance(),
    staleTime: 1000 * 30,
    enabled,
  });
};

export const useBillingStatus = () => {
  return useQuery({
    queryKey: billingKeys.status(),
    queryFn: () => billingApiV2.checkBillingStatus(),
    staleTime: 1000 * 30,
  });
};

export const useTransactions = (limit = 50, offset = 0) => {
  return useQuery({
    queryKey: billingKeys.transactions(limit, offset),
    queryFn: () => billingApiV2.getTransactions(limit, offset),
    staleTime: 1000 * 60 * 5,
  });
};

export const useUsageHistory = (days = 30) => {
  return useQuery({
    queryKey: billingKeys.usageHistory(days),
    queryFn: () => billingApiV2.getUsageHistory(days),
    staleTime: 1000 * 60 * 10,
  });
};

export const useCreateCheckoutSession = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: CreateCheckoutSessionRequest) => 
      billingApiV2.createCheckoutSession(request),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    },
  });
};

export const useCreatePortalSession = () => {
  return useMutation({
    mutationFn: (request: CreatePortalSessionRequest) => 
      billingApiV2.createPortalSession(request),
    onSuccess: (data) => {
      if (data.portal_url) {
        window.location.href = data.portal_url;
      }
    },
  });
};

export const useCancelSubscription = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request?: CancelSubscriptionRequest) => 
      billingApiV2.cancelSubscription(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
    },
  });
};

export const useReactivateSubscription = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApiV2.reactivateSubscription(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
    },
  });
};

export const usePurchaseCredits = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: PurchaseCreditsRequest) => 
      billingApiV2.purchaseCredits(request),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
      queryClient.invalidateQueries({ queryKey: billingKeys.transactions() });
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    },
  });
};

export const useDeductTokenUsage = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (usage: TokenUsage) => billingApiV2.deductTokenUsage(usage),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
      queryClient.invalidateQueries({ queryKey: billingKeys.status() });
    },
  });
};

export const useTriggerTestRenewal = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApiV2.triggerTestRenewal(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.all });
    },
  });
}; 