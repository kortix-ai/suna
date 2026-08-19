'use client';

import { useAccountState } from '@/hooks/billing';
import {
  type BillingState,
  billingStateAllowsRun,
  resolveBillingState,
} from '@/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { getProjectDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

export function useProjectCanRun(projectId: string | undefined) {
  const { data: projectDetail, isLoading: projectLoading } = useQuery({
    queryKey: qk.project.detail(projectId ?? ''),
    queryFn: () => {
      if (!projectId) throw new Error('Missing project id');
      return getProjectDetail(projectId);
    },
    enabled: !!projectId,
    ...contract('config'),
  });

  const accountId = projectDetail?.project?.account_id ?? undefined;
  const { data: accountState, isLoading: accountLoading } = useAccountState({
    accountId,
    enabled: !!accountId,
  });

  if (!isBillingEnabled()) {
    return { canRun: true, isLoading: false, accountId, billingState: null as BillingState | null };
  }

  if (!projectId || projectLoading || (accountId && accountLoading)) {
    return { canRun: false, isLoading: true, accountId, billingState: null as BillingState | null };
  }

  if (!accountId) {
    return { canRun: false, isLoading: false, accountId, billingState: null as BillingState | null };
  }

  // Resolved through the ONE billing-state resolver, so "can this account run"
  // has the same answer here, on the session page, and in the API's gate.
  const billingState = resolveBillingState(accountState);
  return {
    canRun: !!accountState && billingStateAllowsRun(billingState),
    isLoading: false,
    accountId,
    billingState,
  };
}
