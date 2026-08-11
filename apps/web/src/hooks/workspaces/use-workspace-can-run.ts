'use client';

import { useAccountState } from '@/hooks/billing';
import {
  type BillingState,
  billingStateAllowsRun,
  resolveBillingState,
} from '@/lib/billing/billing-gate-state';
import { isBillingEnabled } from '@/lib/config';
import { getWorkspaceDetail } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

export function useWorkspaceCanRun(workspaceId: string | undefined) {
  const { data: workspaceDetail, isLoading: workspaceLoading } = useQuery({
    queryKey: qk.workspace.detail(workspaceId ?? ''),
    queryFn: () => {
      if (!workspaceId) throw new Error('Missing workspace id');
      return getWorkspaceDetail(workspaceId);
    },
    enabled: !!workspaceId,
    ...contract('config'),
  });

  const accountId = workspaceDetail?.workspace?.account_id ?? undefined;
  const { data: accountState, isLoading: accountLoading } = useAccountState({
    accountId,
    enabled: !!accountId,
  });

  if (!isBillingEnabled()) {
    return { canRun: true, isLoading: false, accountId, billingState: null as BillingState | null };
  }

  if (!workspaceId || workspaceLoading || (accountId && accountLoading)) {
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
