/**
 * Billing Validation
 * 
 * Validates billing status and checks before actions
 */

import { useCallback, useState } from 'react';
import { useBillingContext } from '@/contexts/BillingContext';

export function useBillingCheck() {
  const { billingStatus, checkBillingStatus } = useBillingContext();
  const [showAlert, setShowAlert] = useState(false);

  const requireBilling = useCallback(
    async (action?: string): Promise<boolean> => {
      console.log('💳 Checking billing for action:', action);

      // Check current status
      if (billingStatus?.can_run) {
        return true;
      }

      // Refresh status
      const canProceed = await checkBillingStatus();
      
      if (!canProceed) {
        console.log('❌ Insufficient credits');
        setShowAlert(true);
        return false;
      }

      return true;
    },
    [billingStatus, checkBillingStatus]
  );

  const dismissAlert = useCallback(() => {
    setShowAlert(false);
  }, []);

  return {
    requireBilling,
    canRun: billingStatus?.can_run ?? false,
    showAlert,
    dismissAlert,
  };
}

