import * as React from 'react';
import { useBillingContext } from '@/contexts/BillingContext';
import { useAuthContext } from '@/contexts';

/**
 * Account Setup Hook
 * 
 * Determines if account setup is needed (fallback case).
 * 
 * NOTE: Most users are initialized automatically via backend webhook on signup.
 * This hook is used to detect if setup is still needed (webhook failed or old user).
 */
export function useAccountSetup() {
  const { isAuthenticated } = useAuthContext();
  const { hasActiveSubscription, subscriptionData, isLoading: billingLoading } = useBillingContext();

  // We're "checking" if billing is loading (now includes auth loading)
  const isChecking = billingLoading;

  // Only say we need setup if:
  // 1. We're authenticated
  // 2. Billing has finished loading
  // 3. We don't have an active subscription
  const needsSetup = isAuthenticated && !isChecking && !hasActiveSubscription;

  // Debug logging
  React.useEffect(() => {
    console.log('🔧 useAccountSetup state:', {
      billingLoading,
      isChecking,
      isAuthenticated,
      hasActiveSubscription,
      subscriptionData: subscriptionData ? 'has data' : 'null/undefined',
      needsSetup
    });
  }, [billingLoading, isChecking, isAuthenticated, hasActiveSubscription, subscriptionData, needsSetup]);

  const markSetupComplete = async () => {
    console.log('✅ Setup marked as complete (billing context will reflect this)');
  };

  return {
    isChecking,
    needsSetup,
    markSetupComplete,
    setupError: null,
    isInitializing: false,
    attemptCount: 0,
  };
}

