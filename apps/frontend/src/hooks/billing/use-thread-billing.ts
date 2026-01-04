import { useCallback, useEffect, useRef } from 'react';
import { isLocalMode } from '@/lib/config';
import { useAccountState, accountStateSelectors } from './use-account-state';
import { AgentStatus } from '@/components/thread/types';

interface UseThreadBillingReturn {
  checkBillingLimits: () => Promise<boolean>;
  canRun: boolean;
  isLoading: boolean;
}

export function useThreadBilling(
  projectAccountId: string | null | undefined,
  agentStatus: AgentStatus,
  initialLoadCompleted: boolean,
  onBillingError?: () => void,
  enabled = true
): UseThreadBillingReturn {
  const previousAgentStatus = useRef<AgentStatus>('idle');
  const accountState = useAccountState({ enabled });
  
  const canRun = accountStateSelectors.canRun(accountState.data);

  const checkBillingLimits = useCallback(async () => {
    if (isLocalMode()) {
      return false;
    }

    try {
      const result = await accountState.refetch();
      
      if (result.data && !accountStateSelectors.canRun(result.data)) {
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
  }, [accountState, onBillingError]);

  // Check billing after agent run completes
  useEffect(() => {
    const previousStatus = previousAgentStatus.current;
    if (previousStatus === 'running' && agentStatus === 'idle') {
      checkBillingLimits();
    }
    previousAgentStatus.current = agentStatus;
  }, [agentStatus, checkBillingLimits]);

  // Initial billing check
  useEffect(() => {
    if (projectAccountId && initialLoadCompleted && !accountState.data) {
      checkBillingLimits();
    }
  }, [projectAccountId, checkBillingLimits, initialLoadCompleted, accountState.data]);

  return {
    checkBillingLimits,
    canRun,
    isLoading: accountState.isLoading,
  };
}
