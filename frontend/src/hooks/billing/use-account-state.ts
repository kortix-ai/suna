'use client';

/**
 * Unified Account State Hook
 * 
 * Single source of truth for all billing data:
 * - Credits (total, daily, monthly, extra)
 * - Subscription (tier, status, billing period)
 * - Available models
 * - Limits (projects, threads, concurrent runs)
 * 
 * Replaces: useSubscription, useCreditBalance, useBillingStatus, useScheduledChanges
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { siteConfig } from '@/lib/home';
import {
  billingApi,
  AccountState,
  CreateCheckoutSessionRequest,
  CreatePortalSessionRequest,
  CancelSubscriptionRequest,
  PurchaseCreditsRequest,
  TokenUsage,
  ScheduleDowngradeRequest,
} from '@/lib/api/billing';

// =============================================================================
// QUERY KEYS - Single key for all billing state
// =============================================================================

export const accountStateKeys = {
  all: ['account-state'] as const,
  state: () => [...accountStateKeys.all, 'state'] as const,
  usageHistory: (days?: number) => [...accountStateKeys.all, 'usage-history', { days }] as const,
  transactions: (limit?: number, offset?: number) => [...accountStateKeys.all, 'transactions', { limit, offset }] as const,
  trial: () => [...accountStateKeys.all, 'trial'] as const,
};

// =============================================================================
// UTILITY - Invalidation helper for mutations
// =============================================================================

// Global deduplication state for account state refetches
let refetchTimeout: NodeJS.Timeout | null = null;
let pendingSkipCache = false;
let activeRefetchPromise: Promise<void> | null = null;
const REFETCH_DEBOUNCE_MS = 200;

export function invalidateAccountState(queryClient: ReturnType<typeof useQueryClient>, refetch = false, skipCache = false) {
  // Invalidate the query cache (marks data as stale)
  queryClient.invalidateQueries({ queryKey: accountStateKeys.state() });
  
  if (!refetch) return;
  
  // Track if any caller wants skipCache (most aggressive wins)
  if (skipCache) {
    pendingSkipCache = true;
  }
  
  // If there's already an active refetch in progress, just queue the skipCache preference
  if (activeRefetchPromise) {
    return;
  }
  
  // Clear any pending debounce timeout
  if (refetchTimeout) {
    clearTimeout(refetchTimeout);
  }
  
  // Debounce to batch multiple rapid calls into one
  refetchTimeout = setTimeout(() => {
    const shouldSkipCache = pendingSkipCache;
    pendingSkipCache = false;
    refetchTimeout = null;
    
    // Create a single promise that all callers will share
    activeRefetchPromise = (async () => {
      try {
        // Use refetchQueries which properly deduplicates across components
        // The queryFn in the useAccountState hook will handle skipCache
        if (shouldSkipCache) {
          // For skipCache, we need to bypass the cached queryFn
          // Use setQueryData with fresh data
          const freshData = await billingApi.getAccountState(true);
          queryClient.setQueryData(accountStateKeys.state(), freshData);
        } else {
          // Normal refetch - React Query handles deduplication
          await queryClient.refetchQueries({ 
            queryKey: accountStateKeys.state(),
            type: 'active',
          });
        }
      } finally {
        activeRefetchPromise = null;
      }
    })();
  }, REFETCH_DEBOUNCE_MS);
}

// =============================================================================
// MAIN HOOK - Single query for all billing data
// =============================================================================

interface UseAccountStateOptions {
  enabled?: boolean;
  staleTime?: number;
  refetchOnMount?: boolean;
  refetchOnWindowFocus?: boolean;
  skipCache?: boolean; // Skip backend cache (useful after checkout/subscription changes)
}

/**
 * Unified hook for all account billing state.
 * 
 * This replaces:
 * - useSubscription()
 * - useCreditBalance()
 * - useBillingStatus() 
 * - useScheduledChanges()
 * - useAvailableModels() (models are now in account state)
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
    queryFn: () => billingApi.getAccountState(options?.skipCache ?? false),
    enabled,
    staleTime: options?.staleTime ?? 1000 * 60 * 10, // 10 minutes
    gcTime: 1000 * 60 * 15, // 15 minutes
    refetchOnWindowFocus: options?.refetchOnWindowFocus ?? false,
    refetchOnMount: options?.refetchOnMount ?? false,
    refetchOnReconnect: true,
    // Enable request deduplication - React Query will batch simultaneous requests
    structuralSharing: true,
    retry: enabled ? (failureCount, error) => {
      const message = (error as Error).message || '';
      // Don't retry on auth errors
      if (message.includes('401') || message.includes('403')) {
        return false;
      }
      return failureCount < 2;
    } : false,
  });
}

// =============================================================================
// STREAMING VARIANT - For use during agent runs
// =============================================================================

/**
 * Account state with periodic refresh during streaming.
 * Use this in components that display credits during agent runs.
 */
export function useAccountStateWithStreaming(isStreaming: boolean = false) {
  return useQuery<AccountState>({
    queryKey: accountStateKeys.state(),
    queryFn: () => billingApi.getAccountState(),
    staleTime: 1000 * 60 * 5, // 5 minutes during streaming
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    // Slower refresh during streaming - credits update via backend cache invalidation
    refetchInterval: isStreaming ? 2 * 60 * 1000 : false, // 2 minutes if streaming
    refetchIntervalInBackground: false,
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
      // Invalidate and refetch on upgrade/update - checkout redirects user anyway
      if (data.status === 'upgraded' || data.status === 'updated') {
        invalidateAccountState(queryClient, true, true); // Force refetch with skipCache after checkout
      }
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    },
  });
}

export function useCreatePortalSession() {
  return useMutation({
    mutationFn: (params: CreatePortalSessionRequest) => billingApi.createPortalSession(params),
    onSuccess: (data) => {
      const portalUrl = data?.portal_url || (data as any)?.url;
      if (portalUrl) {
        window.location.href = portalUrl;
      } else {
        toast.error('Failed to create portal session. Please try again.');
      }
    },
    onError: (error: any) => {
      toast.error(error?.message || 'Failed to open subscription portal. Please try again.');
    },
  });
}

export function useCancelSubscription() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request?: CancelSubscriptionRequest) => billingApi.cancelSubscription(request),
    onSuccess: (response) => {
      invalidateAccountState(queryClient, true); // Refetch to show updated state
      if (response.success) {
        toast.success(response.message);
      } else {
        toast.error(response.message);
      }
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to cancel subscription');
    },
  });
}

export function useReactivateSubscription() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApi.reactivateSubscription(),
    onSuccess: (response) => {
      invalidateAccountState(queryClient, true); // Refetch to show updated state
      if (response.success) {
        toast.success(response.message);
      } else {
        toast.error(response.message);
      }
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to reactivate subscription');
    },
  });
}

export function usePurchaseCredits() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: PurchaseCreditsRequest) => billingApi.purchaseCredits(request),
    onSuccess: (data) => {
      // Will redirect to checkout - invalidation happens on return via backend
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    },
  });
}

export function useDeductTokenUsage() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (usage: TokenUsage) => billingApi.deductTokenUsage(usage),
    onSuccess: () => {
      // Backend invalidates cache - we just need to refetch
      invalidateAccountState(queryClient);
    },
  });
}

export function useScheduleDowngrade() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: (request: ScheduleDowngradeRequest) => billingApi.scheduleDowngrade(request),
    onSuccess: (response) => {
      invalidateAccountState(queryClient, true); // Refetch to show scheduled change
      if (response.success) {
        toast.success(response.message);
      } else {
        toast.error(response.message);
      }
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to schedule downgrade');
    },
  });
}

export function useCancelScheduledChange() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApi.cancelScheduledChange(),
    onSuccess: (response) => {
      invalidateAccountState(queryClient, true); // Refetch to show updated state
      if (response.success) {
        toast.success(response.message);
      } else {
        toast.error(response.message);
      }
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to cancel scheduled change');
    },
  });
}

export function useSyncSubscription() {
  const queryClient = useQueryClient();
  
  return useMutation({
    mutationFn: () => billingApi.syncSubscription(),
    onSuccess: () => {
      invalidateAccountState(queryClient);
      toast.success('Subscription synced successfully');
    },
    onError: (error: any) => {
      toast.error(error.message || 'Failed to sync subscription');
    },
  });
}

// =============================================================================
// USAGE HISTORY & TRANSACTIONS - Separate queries for analytics
// =============================================================================

export function useUsageHistory(days = 30) {
  return useQuery({
    queryKey: accountStateKeys.usageHistory(days),
    queryFn: () => billingApi.getUsageHistory(days),
    staleTime: 1000 * 60 * 10, // 10 minutes
  });
}

export function useTransactions(limit = 50, offset = 0) {
  return useQuery({
    queryKey: accountStateKeys.transactions(limit, offset),
    queryFn: () => billingApi.getTransactions(limit, offset),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

// =============================================================================
// TRIAL HOOKS
// =============================================================================

export function useTrialStatus(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: accountStateKeys.trial(),
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
        window.location.href = data.checkout_url;
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
      if (response.success) {
        toast.success(response.message);
      }
    },
  });
}

// =============================================================================
// SELECTORS - Helper functions to extract specific data from account state
// =============================================================================

export const accountStateSelectors = {
  /** Check if user can run agents (has credits) */
  canRun: (state: AccountState | undefined) => state?.credits.can_run ?? false,
  
  /** Get total credits */
  totalCredits: (state: AccountState | undefined) => state?.credits.total ?? 0,
  
  /** Get tier key */
  tierKey: (state: AccountState | undefined) => state?.subscription.tier_key ?? 'none',
  
  /** Get tier display name */
  tierDisplayName: (state: AccountState | undefined) => 
    state?.subscription.tier_display_name ?? 'No Plan',
  
  /** Get plan name for TierBadge (e.g., 'Plus', 'Pro', 'Ultra', 'Basic') */
  planName: (state: AccountState | undefined) => {
    if (!state) return 'Basic';
    const tierKey = state.subscription.tier_key || state.tier?.name;
    if (!tierKey || tierKey === 'none' || tierKey === 'free') return 'Basic';
    
    // Use siteConfig to match tier_key to frontend tier names
    const tier = siteConfig.cloudPricingItems.find(p => p.tierKey === tierKey);
    return tier?.name || 'Basic';
  },
  
  /** Check if on trial */
  isTrial: (state: AccountState | undefined) => state?.subscription.is_trial ?? false,
  
  /** Check if subscription is cancelled */
  isCancelled: (state: AccountState | undefined) => state?.subscription.is_cancelled ?? false,
  
  /** Get allowed models */
  allowedModels: (state: AccountState | undefined) => 
    state?.models.filter(m => m.allowed) ?? [],
  
  /** Check if a specific model is allowed */
  isModelAllowed: (state: AccountState | undefined, modelId: string) =>
    state?.models.find(m => m.id === modelId)?.allowed ?? false,
  
  /** Get scheduled change info */
  scheduledChange: (state: AccountState | undefined) => state?.subscription.scheduled_change,
  
  /** Check if has scheduled change */
  hasScheduledChange: (state: AccountState | undefined) => 
    state?.subscription.has_scheduled_change ?? false,
  
  /** Get commitment info */
  commitment: (state: AccountState | undefined) => state?.subscription.commitment,
  
  /** Check if can purchase credits */
  canPurchaseCredits: (state: AccountState | undefined) => 
    state?.subscription.can_purchase_credits ?? false,
    
  /** Get daily credits info */
  dailyCreditsInfo: (state: AccountState | undefined) => state?.credits.daily_refresh,
};

