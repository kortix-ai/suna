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
import { toast } from '@/lib/toast';
import { useBillingAccountId } from '@/stores/billing-account-context';

import { CREDITS_PER_DOLLAR, dollarsToCredits } from '@kortix/shared';
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
  // Scope each query by accountId. `undefined` means "the user's primary
  // account" (resolved server-side from the auth user) — used by global
  // surfaces like the user menu. /accounts/[id] pages pass the explicit id so
  // multi-account users don't see the same wallet/limits across all pages.
  state: (accountId?: string) =>
    [...accountStateKeys.all, 'state', { accountId: accountId ?? null }] as const,
  usageHistory: (days?: number) => [...accountStateKeys.all, 'usage-history', { days }] as const,
  transactions: (limit?: number, offset?: number) => [...accountStateKeys.all, 'transactions', { limit, offset }] as const,
};

// =============================================================================
// UTILITY - Invalidation helper for mutations
// =============================================================================

// Global deduplication state for account state refetches
let refetchTimeout: NodeJS.Timeout | null = null;
let pendingSkipCache = false;
let activeRefetchPromise: Promise<void> | null = null;
const REFETCH_DEBOUNCE_MS = 200;

export function invalidateAccountState(
  queryClient: ReturnType<typeof useQueryClient>,
  refetch = false,
  skipCache = false,
  accountId?: string,
) {
  // Invalidate the query cache (marks data as stale). Per-account queries
  // have their own cache slot (see accountStateKeys.state).
  queryClient.invalidateQueries({ queryKey: accountStateKeys.state(accountId) });
  // Also invalidate the global (primary-account) slot when a per-account
  // mutation lands — global surfaces should reflect the new state too if
  // they happen to point at the same account.
  if (accountId) {
    queryClient.invalidateQueries({ queryKey: accountStateKeys.state() });
  }

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
          const freshData = await billingApi.getAccountState(true, accountId);
          queryClient.setQueryData(accountStateKeys.state(accountId), freshData);
        } else {
          // Normal refetch - React Query handles deduplication
          await queryClient.refetchQueries({
            queryKey: accountStateKeys.state(accountId),
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
  /** Fetch a specific account's state. Defaults to the user's primary account. */
  accountId?: string;
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
  // Explicit option wins; fall back to the nearest BillingAccountProvider so
  // any consumer inside /accounts/[id] is automatically scoped without
  // every call site having to pass the id by hand.
  const contextAccountId = useBillingAccountId();
  const accountId = options?.accountId ?? contextAccountId;

  return useQuery<AccountState>({
    queryKey: accountStateKeys.state(accountId),
    queryFn: () => billingApi.getAccountState(options?.skipCache ?? false, accountId),
    enabled,
    staleTime: options?.staleTime ?? 1000 * 60 * 2,
    gcTime: 1000 * 60 * 15,
    refetchOnWindowFocus: options?.refetchOnWindowFocus ?? false,
    // 'always' caused a fetch on every component mount (6+ consumers).
    // Use true instead: only refetches if data is stale (past staleTime).
    refetchOnMount: options?.refetchOnMount ?? true,
    refetchOnReconnect: true,
    structuralSharing: true,
    retry: enabled ? (failureCount, error) => {
      const message = (error as Error).message || '';
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
  // Inherit the BillingAccountProvider if one is wrapping us — keeps the
  // streaming variant aligned with the static one on /accounts/[id].
  const accountId = useBillingAccountId();
  return useQuery<AccountState>({
    queryKey: accountStateKeys.state(accountId),
    queryFn: () => billingApi.getAccountState(false, accountId),
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
  const accountId = useBillingAccountId();

  return useMutation({
    mutationFn: (request: CreateCheckoutSessionRequest) =>
      billingApi.createCheckoutSession(request, accountId),
    onSuccess: (data) => {
      // Invalidate and refetch on upgrade/update - checkout redirects user anyway
      if (data.status === 'upgraded' || data.status === 'updated') {
        invalidateAccountState(queryClient, true, true, accountId); // Force refetch with skipCache after checkout
      }
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      }
    },
  });
}

// Billing v2 — start the per-seat subscription flow. If a card is on file,
// the API creates the subscription directly and returns { status: 'subscription_created' };
// otherwise it returns { status: 'checkout_created', checkout_url } and we redirect.
export function useCreatePerSeatCheckout() {
  const queryClient = useQueryClient();
  const accountId = useBillingAccountId();

  return useMutation({
    mutationFn: (args: { success_url: string; cancel_url: string; locale?: string }) =>
      billingApi.createPerSeatCheckout(args, accountId),
    onSuccess: async (data) => {
      if (data.status === 'subscription_created') {
        // Direct sub creation (Stripe found a saved payment method on the customer
        // and skipped Checkout). Without explicit feedback the dialog appears to
        // hang — the request settles but nothing visibly changes. Close the
        // dialog, toast, and refresh account state so the new tier + wallet
        // grant land in the UI.
        const { useUpgradeDialogStore } = await import('@/stores/upgrade-dialog-store');
        useUpgradeDialogStore.getState().closeUpgradeDialog();
        await invalidateAccountState(queryClient, true, true, accountId);
        toast.success('Subscription activated', {
          description: `${data.seat_count} seat${data.seat_count === 1 ? '' : 's'} active · $20 of usage credit deposited.`,
        });
        return;
      }
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
        return;
      }
      // Shouldn't happen — API always returns one of the two shapes. Fail loud
      // instead of silently leaving the dialog spinning.
      toast.error('Checkout did not start', {
        description: 'No checkout URL was returned. Try again or contact support.',
      });
    },
    onError: (err: any) => {
      toast.error('Checkout failed to start', {
        description: err?.message || 'Try again, or contact support if this keeps happening.',
      });
    },
  });
}

// Billing v2 — legacy → per-seat voluntary claim. Runs the migration synchronously
// (the lazy sign-in path can silently skip/fail, leaving legacy users stuck with
// no way to switch), then refreshes account state so the new plan + wallet credit
// show immediately.
export function useClaimPerSeat() {
  const queryClient = useQueryClient();
  const accountId = useBillingAccountId();
  return useMutation({
    mutationFn: () => billingApi.claimPerSeat(accountId),
    onSuccess: async (data) => {
      await invalidateAccountState(queryClient, true, true, accountId);
      if (data.status === 'migrated') {
        const parts: string[] = [];
        if (data.first_seat_covered_usd > 0) parts.push(`$${data.first_seat_covered_usd.toFixed(2)} covered your first seat`);
        if (data.credited_usd > 0) parts.push(`$${data.credited_usd.toFixed(2)} added as non-expiring credit`);
        toast.success("You're on seat-based pricing", { description: parts.join(' · ') || undefined });
      } else if (data.status === 'skipped:already_per_seat' || data.status === 'skipped:no_subs') {
        // no_subs flips the flag with no Stripe work — they're now on per-seat.
        toast.success("You're on seat-based pricing");
      } else if (data.status === 'skipped:yearly_commitment') {
        toast.message('Still on a yearly commitment', {
          description: data.reason || 'You can switch once your committed term ends.',
        });
      } else {
        // skipped:no_legacy_machine — nothing to move off of.
        toast.message('Nothing to switch', {
          description: 'No active machine subscription to move to seat-based pricing.',
        });
      }
    },
    onError: (err: any) => {
      toast.error('Could not switch plans', {
        description: err?.message || 'Try again, or contact support if this keeps happening.',
      });
    },
  });
}

export function useCreatePortalSession() {
  const accountId = useBillingAccountId();
  return useMutation({
    mutationFn: (params: CreatePortalSessionRequest) => billingApi.createPortalSession(params, accountId),
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
  const accountId = useBillingAccountId();

  return useMutation({
    mutationFn: (request?: CancelSubscriptionRequest) => billingApi.cancelSubscription(request, accountId),
    onSuccess: (response) => {
      invalidateAccountState(queryClient, true, false, accountId); // Refetch to show updated state
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
  const accountId = useBillingAccountId();

  return useMutation({
    mutationFn: () => billingApi.reactivateSubscription(accountId),
    onSuccess: (response) => {
      invalidateAccountState(queryClient, true, false, accountId); // Refetch to show updated state
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
  const accountId = useBillingAccountId();

  return useMutation({
    mutationFn: (request: PurchaseCreditsRequest) => billingApi.purchaseCredits(request, accountId),
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
  const accountId = useBillingAccountId();

  return useMutation({
    mutationFn: (request: ScheduleDowngradeRequest) => billingApi.scheduleDowngrade(request, accountId),
    onSuccess: (response) => {
      invalidateAccountState(queryClient, true, false, accountId); // Refetch to show scheduled change
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
  const accountId = useBillingAccountId();

  return useMutation({
    mutationFn: () => billingApi.cancelScheduledChange(accountId),
    onSuccess: (response) => {
      invalidateAccountState(queryClient, true, false, accountId); // Refetch to show updated state
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
  const accountId = useBillingAccountId();

  return useMutation({
    mutationFn: () => billingApi.syncSubscription(accountId),
    onSuccess: () => {
      invalidateAccountState(queryClient, false, false, accountId);
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

// `useTransactions` (rich variant with typeFilter) lives in `./use-transactions`
// and is the only one actually used by the BillingTab history block. The
// previous duplicate here was a thin wrapper that the index re-exported but
// nothing imported — removed to avoid two hooks with the same name backed by
// different cache keys.

// =============================================================================
// SELECTORS - Helper functions to extract specific data from account state
// =============================================================================

export const accountStateSelectors = {
  /** Check if user can run agents (has credits) */
  canRun: (state: AccountState | undefined) => state?.credits?.can_run ?? false,
  
  /** Get total credits (converted from dollars to credits using 1$ = 100 credits) */
  totalCredits: (state: AccountState | undefined) => dollarsToCredits(state?.credits?.total ?? 0),
  
  /** Get daily credits (converted from dollars to credits using 1$ = 100 credits) */
  dailyCredits: (state: AccountState | undefined) => dollarsToCredits(state?.credits?.daily ?? 0),
  
  /** Get monthly credits (converted from dollars to credits using 1$ = 100 credits) */
  monthlyCredits: (state: AccountState | undefined) => dollarsToCredits(state?.credits?.monthly ?? 0),
  
  /** Get extra/non-expiring credits (converted from dollars to credits using 1$ = 100 credits) */
  extraCredits: (state: AccountState | undefined) => dollarsToCredits(state?.credits?.extra ?? 0),
  
  /** Get tier monthly credits limit (converted from dollars to credits using 1$ = 100 credits) */
  tierMonthlyCredits: (state: AccountState | undefined) => dollarsToCredits(state?.tier?.monthly_credits ?? 0),
  
  /** Get tier key */
  tierKey: (state: AccountState | undefined) => state?.subscription?.tier_key ?? 'none',
  
  /** Get tier display name */
  tierDisplayName: (state: AccountState | undefined) => 
    state?.subscription?.tier_display_name ?? 'No Plan',
  
  /** Get plan name for TierBadge (e.g., 'Plus', 'Pro', 'Ultra', 'Basic') */
  planName: (state: AccountState | undefined) => {
    if (!state?.subscription) return 'Basic';
    const tierKey = state.subscription.tier_key || state.tier?.name;
    if (!tierKey || tierKey === 'none' || tierKey === 'free') return 'Basic';
    
    if (tierKey === 'pro') return 'Pro';
    return 'Basic';
  },
  
  /** Check if subscription is cancelled */
  isCancelled: (state: AccountState | undefined) => state?.subscription?.is_cancelled ?? false,
  
  
  /** Get scheduled change info */
  scheduledChange: (state: AccountState | undefined) => state?.subscription?.scheduled_change,
  
  /** Check if has scheduled change */
  hasScheduledChange: (state: AccountState | undefined) => 
    state?.subscription?.has_scheduled_change ?? false,
  
  /** Get commitment info */
  commitment: (state: AccountState | undefined) => state?.subscription?.commitment,
  
  /** Check if can purchase credits */
  canPurchaseCredits: (state: AccountState | undefined) => 
    state?.subscription?.can_purchase_credits ?? false,
    
  /** Get daily credits info (with converted daily_amount) */
  dailyCreditsInfo: (state: AccountState | undefined) => {
    const dailyRefresh = state?.credits?.daily_refresh;
    if (!dailyRefresh) return null;
    return {
      ...dailyRefresh,
      daily_amount: dollarsToCredits(dailyRefresh.daily_amount),
    };
  },
};

