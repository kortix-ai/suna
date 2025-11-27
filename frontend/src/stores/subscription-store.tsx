import { useEffect } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { AccountState } from '@/lib/api/billing';
import { useAccountState } from '@/hooks/billing';
import { useAuth } from '@/components/AuthProvider';
import React from 'react';

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
    }
  )
);

// Hook to sync React Query with Zustand store
export function useSubscriptionStoreSync() {
  const { user } = useAuth();
  const isAuthenticated = !!user;
  
  const { 
    data: accountState, 
    isLoading, 
    error, 
    refetch 
  } = useAccountState({ enabled: isAuthenticated });
  
  const setAccountState = useSubscriptionStore((state) => state.setAccountState);
  const setLoading = useSubscriptionStore((state) => state.setLoading);
  const setError = useSubscriptionStore((state) => state.setError);
  const setRefetchCallback = useSubscriptionStore((state) => state.setRefetchCallback);
  
  // Sync data to store
  useEffect(() => {
    setAccountState(accountState || null);
  }, [accountState, setAccountState]);
  
  useEffect(() => {
    setLoading(isLoading);
  }, [isLoading, setLoading]);
  
  useEffect(() => {
    setError(error as Error | null);
  }, [error, setError]);
  
  useEffect(() => {
    setRefetchCallback(() => refetch());
  }, [refetch, setRefetchCallback]);
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
    subscriptionData: store.accountState ? {
      status: store.accountState.subscription.status,
      plan_name: store.accountState.subscription.tier_display_name,
      tier_key: store.accountState.subscription.tier_key,
      subscription: store.accountState.subscription.subscription_id ? {
        id: store.accountState.subscription.subscription_id,
        status: store.accountState.subscription.status,
        tier_key: store.accountState.subscription.tier_key,
        current_period_end: store.accountState.subscription.current_period_end || 0,
        cancel_at: store.accountState.subscription.cancellation_effective_date,
        cancel_at_period_end: store.accountState.subscription.cancel_at_period_end,
      } : null,
      tier: {
        name: store.accountState.subscription.tier_key,
        credits: store.accountState.tier.monthly_credits,
      },
      credits: {
        balance: store.accountState.credits.total,
        tier_credits: store.accountState.tier.monthly_credits,
        lifetime_granted: 0,
        lifetime_purchased: 0,
        lifetime_used: 0,
        can_purchase_credits: store.accountState.subscription.can_purchase_credits,
      },
    } : null,
    creditBalance: store.accountState ? {
      balance: store.accountState.credits.total,
      expiring_credits: store.accountState.credits.daily + store.accountState.credits.monthly,
      non_expiring_credits: store.accountState.credits.extra,
      tier: store.accountState.subscription.tier_key,
      can_purchase_credits: store.accountState.subscription.can_purchase_credits,
    } : null,
    isLoading: store.isLoading,
    error: store.error,
    refetch: store.refetch,
    refetchBalance: store.refetch, // Same as refetch now
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
  
  // Use store data if available, otherwise direct query
  const state = store.accountState || accountState;
  
  if (!state) {
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
      subscription: state.subscription.subscription_id ? {
        id: state.subscription.subscription_id,
        status: state.subscription.status,
        tier_key: state.subscription.tier_key,
        current_period_end: state.subscription.current_period_end || 0,
        cancel_at: state.subscription.cancellation_effective_date,
        cancel_at_period_end: state.subscription.cancel_at_period_end,
      } : null,
      tier: {
        name: state.subscription.tier_key,
        credits: state.tier.monthly_credits,
        display_name: state.subscription.tier_display_name,
      },
      credits: {
        balance: state.credits.total,
        tier_credits: state.tier.monthly_credits,
        lifetime_granted: 0,
        lifetime_purchased: 0,
        lifetime_used: 0,
        can_purchase_credits: state.subscription.can_purchase_credits,
      },
      current_usage: 0,
      cost_limit: state.tier.monthly_credits,
      credit_balance: state.credits.total,
      can_purchase_credits: state.subscription.can_purchase_credits,
      is_trial: state.subscription.is_trial,
      trial_status: state.subscription.trial_status,
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
