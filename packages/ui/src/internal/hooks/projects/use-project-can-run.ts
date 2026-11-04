'use client';

import { useAccountState } from '../../billing';
import {
  type BillingState,
  billingStateAllowsRun,
  resolveBillingState,
} from '../../lib/billing/billing-gate-state';
import { getProject, platformConfig } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';

/**
 * Can the account that owns this project run a session? Send, New session and
 * voice calls wait on this answer. The owning account comes from the project
 * row (`GET /projects/:id`, one database read), never from the detail, which
 * reads the repository: a Send pressed while the detail was pending sent
 * nothing until it answered (2026-11-04).
 */
export function useProjectCanRun(projectId: string | undefined) {
  const { data: project, isLoading: projectLoading } = useQuery({
    queryKey: qk.project.summary(projectId ?? ''),
    queryFn: () => {
      if (!projectId) throw new Error('Missing project id');
      return getProject(projectId);
    },
    enabled: !!projectId,
    ...contract('config'),
  });

  const accountId = project?.account_id ?? undefined;
  const { data: accountState, isLoading: accountLoading } = useAccountState({
    accountId,
    enabled: !!accountId,
  });

  if (!platformConfig().billingEnabled) {
    return { canRun: true, isLoading: false, accountId, billingState: null as BillingState | null };
  }

  if (!projectId || projectLoading || (accountId && accountLoading)) {
    return { canRun: false, isLoading: true, accountId, billingState: null as BillingState | null };
  }

  if (!accountId) {
    return {
      canRun: false,
      isLoading: false,
      accountId,
      billingState: null as BillingState | null,
    };
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
