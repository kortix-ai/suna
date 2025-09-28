import { useCallback, useEffect, useRef, useState } from 'react';
import { isLocalMode } from '@/lib/config';
import { useBillingStatusQuery } from '@/hooks/react-query/threads/use-billing-status';
import { BillingData, AgentStatus } from '../_types';

interface UseBillingReturn {
  showBillingAlert: boolean;
  setShowBillingAlert: React.Dispatch<React.SetStateAction<boolean>>;
  billingData: BillingData;
  setBillingData: React.Dispatch<React.SetStateAction<BillingData>>;
  checkBillingLimits: () => Promise<boolean>;
  billingStatusQuery: ReturnType<typeof useBillingStatusQuery>;
}

export function useBilling(
  projectAccountId: string | null | undefined,
  agentStatus: AgentStatus,
  initialLoadCompleted: boolean
): UseBillingReturn {
  const [showBillingAlert, setShowBillingAlert] = useState(false);
  const [billingData, setBillingData] = useState<BillingData>({});
  const previousAgentStatus = useRef<AgentStatus>('idle');
  const billingStatusQuery = useBillingStatusQuery();

  const checkBillingLimits = useCallback(async () => {
    if (isLocalMode()) {
      return false;
    }

    try {
      await billingStatusQuery.refetch();
      const result = billingStatusQuery.data;

      if (result && !result.can_run) {
        setBillingData({
          currentUsage: result.subscription?.minutes_limit || 0,
          limit: result.subscription?.minutes_limit || 0,
          message: result.message || 'Usage limit reached',
          accountId: projectAccountId || null,
        });
        setShowBillingAlert(true);
        return true;
      }
      return false;
    } catch (err) {
      console.error('Error checking billing status:', err);
      return false;
    }
  }, [projectAccountId, billingStatusQuery]);

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
    showBillingAlert,
    setShowBillingAlert,
    billingData,
    setBillingData,
    checkBillingLimits,
    billingStatusQuery,
  };
} 