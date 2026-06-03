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
function useSubscriptionStoreSync() {
  const { user } = useAuth();
  const isAuthenticated = !!user;
  
  const { 
    data: accountState, 
    isLoading, 
    error, 
    refetch 
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
