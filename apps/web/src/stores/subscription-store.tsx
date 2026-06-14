import { useAuth } from '@/features/providers/auth-provider';
import { useAccountState } from '@/hooks/billing';
import { AccountState } from '@/lib/api/billing';
import { dollarsToCredits } from '@kortix/shared';
import React, { useEffect } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface SubscriptionStore {
  accountState: AccountState | null;
  isLoading: boolean;
  error: Error | null;

  // Actions
  setAccountState: (data: AccountState | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: Error | null) => void;
  refetch: () => void;

  // Refetch callbacks (set by hooks)
  _refetchAccountState?: () => void;

  setRefetchCallback: (callback: (() => void) | undefined) => void;
}

export const useSubscriptionStore = create<SubscriptionStore>()(
  devtools(
    (set, get) => ({
      accountState: null,
      isLoading: false,
      error: null,

      setAccountState: (data) => set({ accountState: data }),
      setLoading: (loading) => set({ isLoading: loading }),
      setError: (error) => set({ error }),

      setRefetchCallback: (callback) => {
        set({ _refetchAccountState: callback });
      },

      refetch: () => {
        get()._refetchAccountState?.();
      },
    }),
    {
      name: 'subscription-store',
    },
  ),
);

// Hook to sync React Query with Zustand store
export function useSubscriptionStoreSync() {
  const { user } = useAuth();
  const isAuthenticated = !!user;

  const {
    data: accountState,
    isLoading,
    error,
    refetch,
  } = useAccountState({ enabled: isAuthenticated });

  // Sync data to store — use a single effect to batch updates and avoid
  // cascading re-renders. Each separate useEffect was causing independent
  // Zustand state updates, and the setRefetchCallback wrapper created a
  // new closure on every render, risking an infinite loop.
  useEffect(() => {
    const store = useSubscriptionStore.getState();

    // Only update if values actually changed to avoid unnecessary re-renders
    const nextAccountState = accountState || null;
    const nextError = (error as Error | null) ?? null;

    const updates: Partial<SubscriptionStore> = {};
    if (store.accountState !== nextAccountState) updates.accountState = nextAccountState;
    if (store.isLoading !== isLoading) updates.isLoading = isLoading;
    if (store.error !== nextError) updates.error = nextError;

    if (Object.keys(updates).length > 0) {
      useSubscriptionStore.setState(updates);
    }
  }, [accountState, isLoading, error]);

  // Set refetch callback once — refetch from React Query is stable, so
  // pass it directly instead of wrapping in a new closure each render.
  useEffect(() => {
    useSubscriptionStore.setState({ _refetchAccountState: refetch });
  }, [refetch]);
}

// Component wrapper to sync React Query with Zustand store
export function SubscriptionStoreSync({ children }: { children: React.ReactNode }) {
  useSubscriptionStoreSync();
  return <>{children}</>;
}

// Backward compatibility hooks - map to new unified structure
export function useSubscriptionContext() {
  const store = useSubscriptionStore();

  return {
    subscriptionData: store.accountState?.subscription
      ? {
          status: store.accountState.subscription.status,
          plan_name: store.accountState.subscription.tier_display_name,
          tier_key: store.accountState.subscription.tier_key,
          subscription: store.accountState.subscription.subscription_id
            ? {
                id: store.accountState.subscription.subscription_id,
                status: store.accountState.subscription.status,
                tier_key: store.accountState.subscription.tier_key,
                current_period_end: store.accountState.subscription.current_period_end || 0,
                cancel_at: store.accountState.subscription.cancellation_effective_date,
                cancel_at_period_end: store.accountState.subscription.cancel_at_period_end,
              }
            : null,
          tier: {
            name: store.accountState.subscription.tier_key,
            credits: dollarsToCredits(store.accountState.tier?.monthly_credits ?? 0),
          },
          credits: {
            balance: dollarsToCredits(store.accountState.credits?.total ?? 0),
            tier_credits: dollarsToCredits(store.accountState.tier?.monthly_credits ?? 0),
            lifetime_granted: 0,
            lifetime_purchased: 0,
            lifetime_used: 0,
            can_purchase_credits: store.accountState.subscription.can_purchase_credits,
          },
        }
      : null,
    creditBalance: store.accountState?.subscription
      ? {
          balance: dollarsToCredits(store.accountState.credits?.total ?? 0),
          expiring_credits: dollarsToCredits(
            (store.accountState.credits?.daily ?? 0) + (store.accountState.credits?.monthly ?? 0),
          ),
          non_expiring_credits: dollarsToCredits(store.accountState.credits?.extra ?? 0),
          tier: store.accountState.subscription.tier_key,
          can_purchase_credits: store.accountState.subscription.can_purchase_credits,
        }
      : null,
    isLoading: store.isLoading,
    error: store.error,
    refetch: store.refetch,
    refetchBalance: store.refetch,
  };
}

export function useSharedSubscription() {
  const store = useSubscriptionStore();
  const ctx = useSubscriptionContext();

  return {
    data: ctx.subscriptionData,
    isLoading: store.isLoading,
    error: store.error,
    refetch: store.refetch,
  };
}

export function useSubscriptionData() {
  const store = useSubscriptionStore();
  const { user } = useAuth();

  const { data: accountState, isLoading, error, refetch } = useAccountState({ enabled: !!user });

  const state = store.accountState || accountState;

  if (!state?.subscription) {
    return {
      data: null,
      isLoading: store.isLoading || isLoading,
      error: (store.error || error) as Error | null,
      refetch: store.refetch || refetch,
    };
  }

  return {
    data: {
      status: state.subscription.status,
      plan_name: state.subscription.tier_display_name,
      tier_key: state.subscription.tier_key,
      billing_period: state.subscription.billing_period,
      provider: state.subscription.provider,
      subscription: state.subscription.subscription_id
        ? {
            id: state.subscription.subscription_id,
            status: state.subscription.status,
            tier_key: state.subscription.tier_key,
            current_period_end: state.subscription.current_period_end || 0,
            cancel_at: state.subscription.cancellation_effective_date,
            cancel_at_period_end: state.subscription.cancel_at_period_end,
          }
        : null,
      tier: {
        name: state.subscription.tier_key,
        credits: dollarsToCredits(state.tier?.monthly_credits ?? 0),
        display_name: state.subscription.tier_display_name,
      },
      credits: {
        balance: dollarsToCredits(state.credits?.total ?? 0),
        tier_credits: dollarsToCredits(state.tier?.monthly_credits ?? 0),
        lifetime_granted: 0,
        lifetime_purchased: 0,
        lifetime_used: 0,
        can_purchase_credits: state.subscription.can_purchase_credits,
      },
      current_usage: (() => {
        const isFreeTier =
          state.subscription.tier_key === 'free' ||
          state.subscription.tier_key === 'none' ||
          (state.tier?.monthly_credits ?? 0) === 0;

        if (isFreeTier && state.credits?.daily_refresh?.enabled) {
          const dailyAmount = state.credits.daily_refresh.daily_amount || 0;
          const dailyRemaining = state.credits?.daily || 0;
          return dollarsToCredits(Math.max(0, dailyAmount - dailyRemaining));
        }

        const monthlyCreditsGranted = state.tier?.monthly_credits || 0;
        const monthlyCreditsRemaining = state.credits?.monthly || 0;
        return dollarsToCredits(Math.max(0, monthlyCreditsGranted - monthlyCreditsRemaining));
      })(),
      cost_limit: (() => {
        const isFreeTier =
          state.subscription.tier_key === 'free' ||
          state.subscription.tier_key === 'none' ||
          (state.tier?.monthly_credits ?? 0) === 0;

        if (isFreeTier && state.credits?.daily_refresh?.enabled) {
          return dollarsToCredits(state.credits.daily_refresh.daily_amount || 0);
        }

        return dollarsToCredits(state.tier?.monthly_credits || 0);
      })(),
      credit_balance: dollarsToCredits(state.credits?.total ?? 0),
      can_purchase_credits: state.subscription.can_purchase_credits,
      has_scheduled_change: state.subscription.has_scheduled_change,
      scheduled_change: state.subscription.scheduled_change,
      commitment: state.subscription.commitment,
      is_cancelled: state.subscription.is_cancelled,
      cancellation_effective_date: state.subscription.cancellation_effective_date,
    },
    isLoading: store.isLoading || isLoading,
    error: (store.error || error) as Error | null,
    refetch: store.refetch || refetch,
  };
}
