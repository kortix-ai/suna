import { useBillingContext } from '@/contexts/BillingContext';
import { useAuthContext } from '@/contexts';

export function useAccountSetup() {
  const { isAuthenticated } = useAuthContext();
  const { hasActiveSubscription, subscriptionLoading } = useBillingContext();

  const needsSetup = isAuthenticated && !subscriptionLoading && !hasActiveSubscription;
  const isChecking = subscriptionLoading;

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

