import { useCallback, useEffect, useRef } from 'react';
import { isLocalMode } from '@/lib/config';
import { useBillingStatusQuery } from './use-billing-status';
import { AgentStatus } from '@/components/thread/types';

interface UseThreadBillingReturn {
  checkBillingLimits: () => Promise<boolean>;
  billingStatusQuery: ReturnType<typeof useBillingStatusQuery>;
}

export function useThreadBilling(
  projectAccountId: string | null | undefined,
  agentStatus: AgentStatus,
  initialLoadCompleted: boolean,
  onBillingError?: () => void,
  enabled = true // Add enabled parameter, default to true
): UseThreadBillingReturn {
  const previousAgentStatus = useRef<AgentStatus>('idle');
  const billingStatusQuery = useBillingStatusQuery(enabled); // Pass enabled to query

  const checkBillingLimits = useCallback(async () => {
    if (isLocalMode()) {
      return false;
    }

    try {
      await billingStatusQuery.refetch();
      const result = billingStatusQuery.data;

      if (result && !result.can_run) {
        // Trigger callback if billing limit reached
        if (onBillingError) {
          onBillingError();
        }
        return true;
      }
      return false;
    } catch (err) {
      console.error('Error checking billing status:', err);
      return false;
    }
  }, [billingStatusQuery, onBillingError]);

  useEffect(() => {
    const previousStatus = previousAgentStatus.current;
    if (previousStatus === 'running' && agentStatus === 'idle') {
      checkBillingLimits();
    }
    previousAgentStatus.current = agentStatus;
  }, [agentStatus, checkBillingLimits]);

  useEffect(() => {
    if (projectAccountId && initialLoadCompleted && !billingStatusQuery.data) {
      checkBillingLimits();
    }
  }, [projectAccountId, checkBillingLimits, initialLoadCompleted, billingStatusQuery.data]);

  return {
    checkBillingLimits,
    billingStatusQuery,
  };
}

