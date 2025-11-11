import { useEffect } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { SubscriptionInfo, CreditBalance } from '@/lib/api/billing';
import { useSubscription, useCreditBalance } from '@/hooks/billing';
import { useAuth } from '@/components/AuthProvider';
import React from 'react';

interface SubscriptionStore {
  subscriptionData: SubscriptionInfo | null;
  creditBalance: CreditBalance | null;
  isLoading: boolean;
  error: Error | null;
  
  // Actions
  setSubscriptionData: (data: SubscriptionInfo | null) => void;
  setCreditBalance: (balance: CreditBalance | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: Error | null) => void;
  refetch: () => void;
  refetchBalance: () => void;
  
  // Refetch callbacks (set by hooks)
  _refetchSubscription?: () => void;
  _refetchBalance?: () => void;
  
  setRefetchCallbacks: (callbacks: {
    refetchSubscription?: () => void;
    refetchBalance?: () => void;
  }) => void;
}

export const useSubscriptionStore = create<SubscriptionStore>()(
  devtools(
    (set, get) => ({
      subscriptionData: null,
      creditBalance: null,
      isLoading: false,
      error: null,
      
      setSubscriptionData: (data) => set({ subscriptionData: data }),
      setCreditBalance: (balance) => set({ creditBalance: balance }),
      setLoading: (loading) => set({ isLoading: loading }),
      setError: (error) => set({ error }),
      
      setRefetchCallbacks: (callbacks) => {
        set({
          _refetchSubscription: callbacks.refetchSubscription,
          _refetchBalance: callbacks.refetchBalance,
        });
      },
      
      refetch: () => {
        get()._refetchSubscription?.();
      },
      
      refetchBalance: () => {
        get()._refetchBalance?.();
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
    data: subscriptionData, 
    isLoading: subscriptionLoading, 
    error: subscriptionError, 
    refetch: refetchSubscription 
  } = useSubscription({ enabled: isAuthenticated });
  
  const {
    data: creditBalance,
    isLoading: balanceLoading,
    error: balanceError,
    refetch: refetchBalance
  } = useCreditBalance(isAuthenticated);
  
  const setSubscriptionData = useSubscriptionStore((state) => state.setSubscriptionData);
  const setCreditBalance = useSubscriptionStore((state) => state.setCreditBalance);
  const setLoading = useSubscriptionStore((state) => state.setLoading);
  const setError = useSubscriptionStore((state) => state.setError);
  const setRefetchCallbacks = useSubscriptionStore((state) => state.setRefetchCallbacks);
  
  // Sync data to store
  useEffect(() => {
    setSubscriptionData(subscriptionData || null);
  }, [subscriptionData, setSubscriptionData]);
  
  useEffect(() => {
    setCreditBalance(creditBalance || null);
  }, [creditBalance, setCreditBalance]);
  
  useEffect(() => {
    setLoading(subscriptionLoading || balanceLoading);
  }, [subscriptionLoading, balanceLoading, setLoading]);
  
  useEffect(() => {
    const error = (subscriptionError || balanceError) as Error | null;
    setError(error);
  }, [subscriptionError, balanceError, setError]);
  
  useEffect(() => {
    setRefetchCallbacks({
      refetchSubscription: () => refetchSubscription(),
      refetchBalance: () => refetchBalance(),
    });
  }, [refetchSubscription, refetchBalance, setRefetchCallbacks]);
}

// Component wrapper to sync React Query with Zustand store
export function SubscriptionStoreSync({ children }: { children: React.ReactNode }) {
  useSubscriptionStoreSync();
  return <>{children}</>;
}

// Backward compatibility hooks
export function useSubscriptionContext() {
  const store = useSubscriptionStore();
  
  return {
    subscriptionData: store.subscriptionData,
    creditBalance: store.creditBalance,
    isLoading: store.isLoading,
    error: store.error,
    refetch: store.refetch,
    refetchBalance: store.refetchBalance,
  };
}

export function useSharedSubscription() {
  const store = useSubscriptionStore();
  
  return {
    data: store.subscriptionData,
    isLoading: store.isLoading,
    error: store.error,
    refetch: store.refetch,
  };
}

export function useSubscriptionData() {
  const store = useSubscriptionStore();
  const { user } = useAuth();
  
  const directSubscription = useSubscription({ enabled: !!user });
  const directCreditBalance = useCreditBalance(!!user);
  
  if (store.subscriptionData) {
    return {
      data: store.subscriptionData ? {
        ...store.subscriptionData,
        current_usage: store.creditBalance?.lifetime_used || 0,
        cost_limit: store.subscriptionData.tier.credits,
        credit_balance: store.creditBalance?.balance || 0,
        can_purchase_credits: store.creditBalance?.can_purchase_credits || false,
        subscription: store.subscriptionData.subscription ? {
          ...store.subscriptionData.subscription,
          cancel_at_period_end: store.subscriptionData.subscription.cancel_at ? true : false
        } : null
      } : null,
      isLoading: store.isLoading,
      error: store.error,
      refetch: store.refetch,
    };
  }
  
  // If no store data, use the hooks directly (for use outside provider)
  const { data, isLoading, error, refetch } = directSubscription;
  const { data: creditBalance } = directCreditBalance;
  
  return {
    data: data ? {
      ...data,
      current_usage: creditBalance?.lifetime_used || 0,
      cost_limit: data.tier.credits,
      credit_balance: creditBalance?.balance || 0,
      can_purchase_credits: creditBalance?.can_purchase_credits || false,
      subscription: data.subscription ? {
        ...data.subscription,
        cancel_at_period_end: data.subscription.cancel_at ? true : false
      } : null
    } : null,
    isLoading,
    error: error as Error | null,
    refetch,
  };
}

