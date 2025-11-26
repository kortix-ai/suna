/**
 * Billing Context
 * 
 * Global billing state management
 * Combines subscription, credit balance, and billing status
 */

import React, { createContext, useContext, useCallback, ReactNode } from 'react';
import {
  useSubscription,
  useCreditBalance,
  useBillingStatus,
  billingKeys,
  type SubscriptionInfo,
  type CreditBalance,
  type BillingStatus,
} from '@/lib/billing';
import { useQueryClient } from '@tanstack/react-query';
import { useAuthContext } from './AuthContext';

// ============================================================================
// Context Types
// ============================================================================

export interface BillingContextType {
  // Data
  subscriptionData: SubscriptionInfo | null;
  creditBalance: CreditBalance | null;
  billingStatus: BillingStatus | null;
  
  // Loading states
  isLoading: boolean;
  subscriptionLoading: boolean;
  balanceLoading: boolean;
  statusLoading: boolean;
  
  // Errors
  error: Error | null;
  
  // Actions
  refetchAll: () => void;
  refetchSubscription: () => void;
  refetchBalance: () => void;
  refetchStatus: () => void;
  checkBillingStatus: () => Promise<boolean>;
  
  // Computed states
  hasActiveSubscription: boolean;
  hasFreeTier: boolean;
  needsSubscription: boolean;
}

// ============================================================================
// Context Creation
// ============================================================================

const BillingContext = createContext<BillingContextType | null>(null);

// ============================================================================
// Provider Component
// ============================================================================

interface BillingProviderProps {
  children: ReactNode;
}

export function BillingProvider({ children }: BillingProviderProps) {
  const { isAuthenticated, isLoading: authLoading } = useAuthContext();
  const queryClient = useQueryClient();

  // Handle billing cache based on auth state
  const prevAuthRef = React.useRef<boolean | null>(null);
  React.useEffect(() => {
    if (authLoading) return;
    
    const wasAuthenticated = prevAuthRef.current;
    const justLoggedIn = wasAuthenticated === false && isAuthenticated === true;
    const justLoggedOut = wasAuthenticated === true && isAuthenticated === false;
    
    prevAuthRef.current = isAuthenticated;
    
    if (justLoggedOut) {
      // User logged out - clear all billing data
      console.log('🚫 User logged out - clearing billing cache');
      queryClient.cancelQueries({ queryKey: billingKeys.all });
      queryClient.removeQueries({ queryKey: billingKeys.all });
    } else if (justLoggedIn) {
      // User just logged in - clear any stale errors and invalidate to trigger fresh fetch
      console.log('✅ User logged in - clearing stale billing data and fetching fresh');
      queryClient.removeQueries({ queryKey: billingKeys.all });
      // Small delay to ensure queries re-mount with enabled=true
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: billingKeys.all });
      }, 100);
    }
  }, [isAuthenticated, authLoading, queryClient]);

  // Fetch all billing data (only when authenticated AND not loading)
  const shouldFetchBilling = isAuthenticated === true && !authLoading;
  
  const {
    data: subscriptionData,
    isLoading: subscriptionLoading,
    isFetching: subscriptionFetching,
    error: subscriptionError,
    refetch: refetchSubscription,
  } = useSubscription({
    enabled: shouldFetchBilling,
  });

  const {
    data: creditBalance,
    isLoading: balanceLoading,
    isFetching: balanceFetching,
    error: balanceError,
    refetch: refetchBalance,
  } = useCreditBalance({
    enabled: shouldFetchBilling,
  });

  const {
    data: billingStatus,
    isLoading: statusLoading,
    isFetching: statusFetching,
    error: statusError,
    refetch: refetchStatus,
  } = useBillingStatus({
    enabled: shouldFetchBilling,
  });

  // Loading = true when:
  // 1. Auth is still loading (we don't know if we need to fetch yet)
  // 2. We should be fetching but don't have data yet (initial fetch)
  // 3. Any query is actively loading
  const needsInitialFetch = shouldFetchBilling && subscriptionData === undefined;
  const isLoading = authLoading || needsInitialFetch || subscriptionLoading || balanceLoading || statusLoading;

  // Debug logging for billing state
  React.useEffect(() => {
    console.log('💰 Billing state:', {
      authLoading,
      shouldFetchBilling,
      subscriptionData: subscriptionData !== undefined ? 'has data' : 'undefined',
      subscriptionLoading,
      needsInitialFetch,
      isLoading,
      hasActiveSubscription: subscriptionData?.tier?.name !== 'none' && !!subscriptionData?.tier
    });
  }, [authLoading, shouldFetchBilling, subscriptionData, subscriptionLoading, needsInitialFetch, isLoading]);

  // Combine errors (first error encountered)
  const error =
    (subscriptionError ||
      balanceError ||
      statusError) as Error | null;

  // Refetch all billing data
  const refetchAll = useCallback(() => {
    console.log('🔄 Refetching all billing data...');
    queryClient.invalidateQueries({ queryKey: billingKeys.all });
  }, [queryClient]);

  // Check billing status and return whether user can proceed
  const checkBillingStatus = useCallback(async (): Promise<boolean> => {
    console.log('💳 Checking billing status...');
    
    if (!isAuthenticated) {
      console.log('❌ User not authenticated');
      return false;
    }

    try {
      // Refetch latest status
      const { data } = await refetchStatus();
      
      if (data?.can_run) {
        console.log('✅ Billing check passed');
        return true;
      } else {
        console.log('❌ Insufficient credits');
        return false;
      }
    } catch (err) {
      console.error('❌ Billing check error:', err);
      return false;
    }
  }, [isAuthenticated, refetchStatus]);

  // Computed states for easier access
  const hasActiveSubscription = Boolean(
    subscriptionData?.tier && 
    subscriptionData.tier.name !== 'none'
  );

  const hasFreeTier = Boolean(
    subscriptionData?.tier && 
    subscriptionData.tier.name === 'free'
  );

  const needsSubscription = !hasActiveSubscription;

  // Context value
  const value: BillingContextType = {
    // Data
    subscriptionData: subscriptionData || null,
    creditBalance: creditBalance || null,
    billingStatus: billingStatus || null,

    // Loading states
    isLoading,
    subscriptionLoading,
    balanceLoading,
    statusLoading,

    // Errors
    error,

    // Actions
    refetchAll,
    refetchSubscription,
    refetchBalance,
    refetchStatus,
    checkBillingStatus,
    
    // Computed states
    hasActiveSubscription,
    hasFreeTier,
    needsSubscription,
  };

  return (
    <BillingContext.Provider value={value}>
      {children}
    </BillingContext.Provider>
  );
}

// ============================================================================
// Hook
// ============================================================================

export function useBillingContext(): BillingContextType {
  const context = useContext(BillingContext);

  if (!context) {
    throw new Error('useBillingContext must be used within a BillingProvider');
  }

  return context;
}

// Convenience hook for checking if user has credits
export function useHasCredits(minimumCredits = 0): boolean {
  const { creditBalance } = useBillingContext();

  if (!creditBalance) {
    return false;
  }

  return creditBalance.balance >= minimumCredits;
}

// Convenience hook for subscription tier
export function useSubscriptionTier(): string {
  const { subscriptionData } = useBillingContext();

  if (!subscriptionData) {
    return 'free';
  }

  return subscriptionData.tier.name;
}

