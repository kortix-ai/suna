'use client';

import React, { createContext, useContext, useCallback, useEffect, useRef } from 'react';
import { useBillingStatusQuery } from '@/hooks/react-query/threads/use-billing-status';
import { BillingStatusResponse } from '@/lib/api';
import { isLocalMode } from '@/lib/config';

interface BillingContextType {
  billingStatus: BillingStatusResponse | null;
  isLoading: boolean;
  error: Error | null;
  checkBillingStatus: () => Promise<boolean>;
  lastCheckTime: number | null;
}

const BillingContext = createContext<BillingContextType | null>(null);

export function BillingProvider({ children }: { children: React.ReactNode }) {
  const billingStatusQuery = useBillingStatusQuery();
  const lastCheckRef = useRef<number | null>(null);
  const checkInProgressRef = useRef<boolean>(false);

  const checkBillingStatus = useCallback(async (force = false): Promise<boolean> => {
    if (isLocalMode()) {
      return false;
    }

    if (checkInProgressRef.current) {
      return !billingStatusQuery.data?.can_run;
    }

    const now = Date.now();
    if (!force && lastCheckRef.current && now - lastCheckRef.current < 60000) {
      return !billingStatusQuery.data?.can_run;
    }

    try {
      checkInProgressRef.current = true;
      if (force || billingStatusQuery.isStale) {
        await billingStatusQuery.refetch();
      }
      lastCheckRef.current = now;
      return !billingStatusQuery.data?.can_run;
    } catch (err) {
      console.error('Error checking billing status:', err);
      return false;
    } finally {
      checkInProgressRef.current = false;
    }
  }, [billingStatusQuery]);

  useEffect(() => {
    if (!billingStatusQuery.data) {
      checkBillingStatus(true);
    }
  }, [checkBillingStatus, billingStatusQuery.data]);

  const value = {
    billingStatus: billingStatusQuery.data || null,
    isLoading: billingStatusQuery.isLoading,
    error: billingStatusQuery.error,
    checkBillingStatus,
    lastCheckTime: lastCheckRef.current,
  };

  return (
    <BillingContext.Provider value={value}>
      {children}
    </BillingContext.Provider>
  );
}

export function useBilling() {
  const context = useContext(BillingContext);
  if (!context) {
    throw new Error('useBilling must be used within a BillingProvider');
  }
  return context;
} 