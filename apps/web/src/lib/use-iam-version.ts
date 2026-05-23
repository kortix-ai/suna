'use client';

// useIamV2Enabled — single source of truth for whether the current account
// is on the simplified IAM V2 model. UI surfaces that exist only in V1
// (Policies tab, Roles tab, custom-role pages, conditions UI, deny UI,
// project_groups UI, break-glass, approvals, simulator) check this flag
// and hide themselves when V2 is on.
//
// Reads the value from the cached getAccount() query — no extra network
// call. Returns `false` until the query resolves, so guards fail closed
// (V1 surface shown by default until we know).

import { useQuery } from '@tanstack/react-query';
import { getAccount } from '@/lib/projects-client';

export interface UseIamV2EnabledResult {
  /** True only when the account-info query has resolved AND the flag is on. */
  enabled: boolean;
  isLoading: boolean;
}

export function useIamV2Enabled(accountId: string | undefined): UseIamV2EnabledResult {
  const query = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => getAccount(accountId!),
    enabled: !!accountId,
    staleTime: 60_000,
  });

  return {
    enabled: query.data?.iam_v2_enabled === true,
    isLoading: query.isLoading,
  };
}
