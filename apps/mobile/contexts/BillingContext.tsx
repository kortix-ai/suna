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
  const { isAuthenticated } = useAuthContext();
  const queryClient = useQueryClient();

  // Fetch all billing data (only when authenticated)
  const {
    data: subscriptionData,
    isLoading: subscriptionLoading,
    error: subscriptionError,
    refetch: refetchSubscription,
  } = useSubscription({
    enabled: isAuthenticated,
  });

  const {
    data: creditBalance,
    isLoading: balanceLoading,
    error: balanceError,
    refetch: refetchBalance,
  } = useCreditBalance({
    enabled: isAuthenticated,
  });

  const {
    data: billingStatus,
    isLoading: statusLoading,
    error: statusError,
    refetch: refetchStatus,
  } = useBillingStatus({
    enabled: isAuthenticated,
  });

  // Combine loading states
  const isLoading =
    subscriptionLoading || balanceLoading || statusLoading;

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

