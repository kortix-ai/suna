'use client';

import React, { createContext, useContext, ReactNode } from 'react';
import { useSubscription, useCreditBalance } from '@/hooks/react-query/use-billing-v2';
import { SubscriptionInfo, CreditBalance } from '@/lib/api/billing-v2';
import { useAuth } from '@/components/AuthProvider';

interface SubscriptionContextType {
  subscriptionData: SubscriptionInfo | null;
  creditBalance: CreditBalance | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
  refetchBalance: () => void;
}

const SubscriptionContext = createContext<SubscriptionContextType | null>(null);

interface SubscriptionProviderProps {
  children: ReactNode;
}

export function SubscriptionProvider({ children }: SubscriptionProviderProps) {
  const { user } = useAuth();
  const isAuthenticated = !!user;

  const { 
    data: subscriptionData, 
    isLoading: subscriptionLoading, 
    error: subscriptionError, 
    refetch 
  } = useSubscription(isAuthenticated);

  const {
    data: creditBalance,
    isLoading: balanceLoading,
    error: balanceError,
    refetch: refetchBalance
  } = useCreditBalance(isAuthenticated);

  const value: SubscriptionContextType = {
    subscriptionData: subscriptionData || null,
    creditBalance: creditBalance || null,
    isLoading: subscriptionLoading || balanceLoading,
    error: (subscriptionError || balanceError) as Error | null,
    refetch,
    refetchBalance,
  };

  return (
    <SubscriptionContext.Provider value={value}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscriptionContext() {
  const context = useContext(SubscriptionContext);
  
  if (!context) {
    throw new Error('useSubscriptionContext must be used within a SubscriptionProvider');
  }
  
  return context;
}

export function useHasCredits(minimumCredits = 0) {
  const { creditBalance } = useSubscriptionContext();
  
  if (!creditBalance) {
    return false;
  }
  
  return creditBalance.balance >= minimumCredits;
}

export function useSubscriptionTier() {
  const { subscriptionData } = useSubscriptionContext();
  
  if (!subscriptionData) {
    return 'free';
  }
  
  return subscriptionData.tier.name;
}

export function useSharedSubscription() {
  const context = useSubscriptionContext();
  
  return {
    data: context.subscriptionData,
    isLoading: context.isLoading,
    error: context.error,
    refetch: context.refetch,
  };
}

export function useSubscriptionData() {
  const context = useContext(SubscriptionContext);
  const { user } = useAuth();
  
  const directSubscription = useSubscription(!!user);
  const directCreditBalance = useCreditBalance(!!user);
  
  if (context) {
    return {
      data: context.subscriptionData ? {
        ...context.subscriptionData,
        current_usage: context.creditBalance?.lifetime_used || 0,
        cost_limit: context.subscriptionData.tier.credits,
        credit_balance: context.creditBalance?.balance || 0,
        can_purchase_credits: context.creditBalance?.can_purchase_credits || false,
        subscription: context.subscriptionData.subscription ? {
          ...context.subscriptionData.subscription,
          cancel_at_period_end: context.subscriptionData.subscription.cancel_at ? true : false
        } : null
      } : null,
      isLoading: context.isLoading,
      error: context.error,
      refetch: context.refetch,
    };
  }
  
  // If no context, use the hooks directly (for use outside provider)
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
