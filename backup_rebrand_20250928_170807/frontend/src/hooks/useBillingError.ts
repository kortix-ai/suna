import { useState, useCallback } from 'react';
import { isLocalMode } from '@/lib/config';

interface BillingErrorState {
  message: string;
  currentUsage?: number;
  limit?: number;
  subscription?: {
    price_id?: string;
    plan_name?: string;
    current_usage?: number;
    limit?: number;
  };
}

export function useBillingError() {
  const [billingError, setBillingError] = useState<BillingErrorState | null>(
    null,
  );

  const handleBillingError = useCallback((error: any) => {
    // In local mode, don't process billing errors
    if (isLocalMode()) {
      return false;
    }

    // Case 1: Error is already a formatted billing error detail object
    if (error && (error.message || error.subscription)) {
      setBillingError({
        message: error.message || "You've reached your monthly usage limit.",
        currentUsage: error.currentUsage || error.subscription?.current_usage,
        limit: error.limit || error.subscription?.limit,
        subscription: error.subscription || {},
      });
      return true;
    }

    // Case 2: Error is an HTTP error response
    if (
      error.status === 402 ||
      (error.message && error.message.includes('Payment Required'))
    ) {
      // Try to get details from error.data.detail (common API pattern)
      const errorDetail = error.data?.detail || {};
      const subscription = errorDetail.subscription || {};

      setBillingError({
        message:
          errorDetail.message || "You've reached your monthly usage limit.",
        currentUsage: subscription.current_usage,
        limit: subscription.limit,
        subscription,
      });
      return true;
    }

    // Not a billing error
    return false;
  }, []);

  const clearBillingError = useCallback(() => {
    setBillingError(null);
  }, []);

  return {
    billingError,
    handleBillingError,
    clearBillingError,
  };
}
