'use client';

import { useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { getProjectDetail } from '@/lib/projects-client';
import { useQuery } from '@tanstack/react-query';

export function useProjectCanRun(projectId: string | undefined) {
  const { data: projectDetail, isLoading: projectLoading } = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => {
      if (!projectId) throw new Error('Missing project id');
      return getProjectDetail(projectId);
    },
    enabled: !!projectId,
  });

  const accountId = projectDetail?.project?.account_id ?? undefined;
  const { data: accountState, isLoading: accountLoading } = useAccountState({
    accountId,
    enabled: !!accountId,
  });

  if (!isBillingEnabled()) {
    return { canRun: true, isLoading: false, accountId };
  }

  if (!projectId || projectLoading || (accountId && accountLoading)) {
    return { canRun: false, isLoading: true, accountId };
  }

  if (!accountId) {
    return { canRun: false, isLoading: false, accountId };
  }

  return {
    canRun: accountState?.credits?.can_run ?? false,
    isLoading: false,
    accountId,
  };
}
