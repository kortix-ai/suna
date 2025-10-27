/**
 * Billing Context
 * 
 * Global billing state management
 * Combines subscription, credit balance, billing status, and trial information
 */

import React, { createContext, useContext, useCallback, ReactNode } from 'react';
import {
  useSubscription,
  useCreditBalance,
  useBillingStatus,
  useTrialStatus,
  billingKeys,
  type SubscriptionInfo,
  type CreditBalance,
  type BillingStatus,
  type TrialStatus,
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
  trialStatus: TrialStatus | null;
  
  // Loading states
  isLoading: boolean;
  subscriptionLoading: boolean;
  balanceLoading: boolean;
  statusLoading: boolean;
  trialLoading: boolean;
  
  // Errors
  error: Error | null;
  
  // Actions
  refetchAll: () => void;
  refetchSubscription: () => void;
  refetchBalance: () => void;
  refetchStatus: () => void;
  refetchTrial: () => void;
  checkBillingStatus: () => Promise<boolean>;
  
  // Computed states
  hasActiveSubscription: boolean;
  hasActiveTrial: boolean;
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

  const {
    data: trialStatus,
    isLoading: trialLoading,
    error: trialError,
    refetch: refetchTrial,
  } = useTrialStatus({
    enabled: isAuthenticated,
  });

  // Combine loading states
  const isLoading =
    subscriptionLoading || balanceLoading || statusLoading || trialLoading;

  // Combine errors (first error encountered)
  const error =
    (subscriptionError ||
      balanceError ||
      statusError ||
      trialError) as Error | null;

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
    subscriptionData.tier.name !== 'none' && 
    subscriptionData.tier.name !== 'free'
  );

  const hasActiveTrial = Boolean(
    trialStatus?.has_trial && 
    trialStatus?.trial_status === 'active'
  );

  const needsSubscription = !hasActiveSubscription && !hasActiveTrial;

  // Context value
  const value: BillingContextType = {
    // Data
    subscriptionData: subscriptionData || null,
    creditBalance: creditBalance || null,
    billingStatus: billingStatus || null,
    trialStatus: trialStatus || null,

    // Loading states
    isLoading,
    subscriptionLoading,
    balanceLoading,
    statusLoading,
    trialLoading,

    // Errors
    error,

    // Actions
    refetchAll,
    refetchSubscription,
    refetchBalance,
    refetchStatus,
    refetchTrial,
    checkBillingStatus,
    
    // Computed states
    hasActiveSubscription,
    hasActiveTrial,
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

