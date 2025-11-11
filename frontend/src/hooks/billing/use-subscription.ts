'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  billingApi,
  SubscriptionInfo,
  CommitmentInfo,
  CreatePortalSessionRequest,
  CancelSubscriptionRequest,
  CreateCheckoutSessionRequest,
  PurchaseCreditsRequest,
  TokenUsage,
  ScheduleDowngradeRequest,
  ScheduledChangesResponse,
} from '@/lib/api/billing';
import { useState, useEffect } from 'react';
import { toast } from 'sonner';

export const billingKeys = {
  all: ['billing'] as const,
  subscription: () => [...billingKeys.all, 'subscription'] as const,
  balance: () => [...billingKeys.all, 'balance'] as const,
  status: () => [...billingKeys.all, 'status'] as const,
  transactions: (limit?: number, offset?: number) => 
    [...billingKeys.all, 'transactions', { limit, offset }] as const,
  usageHistory: (days?: number) => 
    [...billingKeys.all, 'usage-history', { days }] as const,
  scheduledChanges: () => [...billingKeys.all, 'scheduled-changes'] as const,
};

// Export billingKeys as subscriptionKeys for backward compatibility
export { billingKeys as subscriptionKeys };

/**
 * Hook to fetch subscription data
 */
export const useSubscription = (options?: {
  enabled?: boolean;
  staleTime?: number;
  refetchOnMount?: boolean;
  refetchOnWindowFocus?: boolean;
}) => {
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
};

/**
 * Hook to fetch subscription data with automatic refetching during streaming
 */
export const useSubscriptionWithStreaming = (isStreaming: boolean = false) => {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  return useQuery<SubscriptionInfo>({
    queryKey: billingKeys.subscription(),
    queryFn: () => billingApi.getSubscription(),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchInterval: (data) => {
      if (!isVisible) return false;
      if (isStreaming) return 2 * 60 * 1000;
      return 10 * 60 * 1000;
    },
    refetchIntervalInBackground: false,
  });
};

/**
 * Hook to create a portal session for managing subscription
 */
export const useCreatePortalSession = () => {
  return useMutation({
    mutationFn: (params: CreatePortalSessionRequest) => billingApi.createPortalSession(params),
    onSuccess: (data) => {
      if (data?.portal_url) {
        window.location.href = data.portal_url;
      }
    },
  });
};

/**
 * Hook to cancel subscription
 */
export const useCancelSubscription = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request?: CancelSubscriptionRequest) => billingApi.cancelSubscription(request),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
      if (response.success) {
        toast.success(response.message);
      } else {
        toast.error(response.message);
      }
    },
    onError: (error: any) => {
      console.error('Error cancelling subscription:', error);
      toast.error(error.message || 'Failed to cancel subscription');
    },
  });
};

/**
 * Hook to reactivate subscription
 */
export const useReactivateSubscription = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApi.reactivateSubscription(),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
      if (response.success) {
        toast.success(response.message);
      } else {
        toast.error(response.message);
      }
    },
    onError: (error: any) => {
      console.error('Error reactivating subscription:', error);
      toast.error(error.message || 'Failed to reactivate subscription');
    },
  });
};

/**
 * Hook to fetch subscription commitment info
 */
export const useSubscriptionCommitment = (subscriptionId?: string, enabled = true) => {
  return useQuery<CommitmentInfo>({
    queryKey: [...billingKeys.subscription(), 'commitment', subscriptionId || ''],
    queryFn: () => billingApi.getSubscriptionCommitment(subscriptionId!),
    enabled: enabled && !!subscriptionId,
    staleTime: 1000 * 60 * 15,
    gcTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
};

/**
 * Hook to fetch credit balance
 */
export const useCreditBalance = (enabled = true) => {
  return useQuery({
    queryKey: billingKeys.balance(),
    queryFn: () => billingApi.getCreditBalance(),
    staleTime: 1000 * 60 * 5, // 5 minutes - increased from 30 seconds
    gcTime: 1000 * 60 * 10, // 10 minutes cache time
    refetchOnWindowFocus: false, // Don't refetch on window focus
    refetchOnMount: false, // Don't refetch on mount if data is fresh
    refetchOnReconnect: true, // Only refetch on reconnect
    enabled,
  });
};

/**
 * Hook to check billing status
 */
export const useBillingStatus = () => {
  return useQuery({
    queryKey: billingKeys.status(),
    queryFn: () => billingApi.checkBillingStatus(),
    staleTime: 1000 * 60 * 5, // 5 minutes - increased from 30 seconds
    gcTime: 1000 * 60 * 10, // 10 minutes cache time
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });
};

/**
 * Hook to fetch usage history
 */
export const useUsageHistory = (days = 30) => {
  return useQuery({
    queryKey: billingKeys.usageHistory(days),
    queryFn: () => billingApi.getUsageHistory(days),
    staleTime: 1000 * 60 * 10,
  });
};

/**
 * Hook to create checkout session
 */
export const useCreateCheckoutSession = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: CreateCheckoutSessionRequest) => 
      billingApi.createCheckoutSession(request),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    },
  });
};

/**
 * Hook to purchase credits
 */
export const usePurchaseCredits = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: PurchaseCreditsRequest) => 
      billingApi.purchaseCredits(request),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
      queryClient.invalidateQueries({ queryKey: billingKeys.transactions() });
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    },
  });
};

/**
 * Hook to deduct token usage
 */
export const useDeductTokenUsage = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (usage: TokenUsage) => billingApi.deductTokenUsage(usage),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
      queryClient.invalidateQueries({ queryKey: billingKeys.status() });
    },
  });
};

/**
 * Hook to trigger test renewal
 */
export const useTriggerTestRenewal = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApi.triggerTestRenewal(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: billingKeys.all });
    },
  });
};

/**
 * Hook to schedule a tier downgrade
 */
export const useScheduleDowngrade = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: ScheduleDowngradeRequest) => billingApi.scheduleDowngrade(request),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      queryClient.invalidateQueries({ queryKey: billingKeys.scheduledChanges() });
      if (response.success) {
        toast.success(response.message);
      } else {
        toast.error(response.message);
      }
    },
    onError: (error: any) => {
      console.error('Error scheduling downgrade:', error);
      toast.error(error.message || 'Failed to schedule downgrade');
    },
  });
};

/**
 * Hook to fetch scheduled tier changes
 */
export const useScheduledChanges = (enabled = true) => {
  return useQuery<ScheduledChangesResponse>({
    queryKey: billingKeys.scheduledChanges(),
    queryFn: () => billingApi.getScheduledChanges(),
    staleTime: 1000 * 60 * 5,
    gcTime: 1000 * 60 * 10,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: true,
    enabled,
  });
};

/**
 * Hook to cancel a scheduled tier change
 */
export const useCancelScheduledChange = () => {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApi.cancelScheduledChange(),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: billingKeys.subscription() });
      queryClient.invalidateQueries({ queryKey: billingKeys.scheduledChanges() });
      if (response.success) {
        toast.success(response.message);
      } else {
        toast.error(response.message);
      }
    },
    onError: (error: any) => {
      console.error('Error cancelling scheduled change:', error);
      toast.error(error.message || 'Failed to cancel scheduled change');
    },
  });
};

/**
 * Utility function to check if subscription matches a plan
 */
export const isPlan = (
  subscriptionData: SubscriptionInfo | null | undefined,
  planId?: string,
): boolean => {
  if (!subscriptionData) return planId === 'free';
  return subscriptionData.plan_name === planId;
};
