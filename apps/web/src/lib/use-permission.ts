'use client';

// usePermission — single source of truth for whether the CURRENT user can
// perform an IAM action against the API. UI gates should call this instead
// of branching on `account.role` directly, otherwise a member granted access
// via an explicit IAM policy still sees buttons disabled.
//
// Implementation: react-query around probeEffectivePermission(). One query
// per (accountId, userId, action, resourceType, resourceId) tuple, cached
// for the React tree's lifetime so multiple components asking for the same
// permission collapse to a single network call.

import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/components/AuthProvider';
import {
  probeEffectivePermission,
  type ResourceType,
} from '@/lib/iam-client';

export interface UsePermissionTarget {
  resourceType?: ResourceType;
  resourceId?: string;
}

export interface UsePermissionResult {
  /** True only when the probe has resolved AND the API said yes.
   * While loading or on error, this is false — UI defaults to hidden/disabled. */
  allowed: boolean;
  isLoading: boolean;
  isError: boolean;
}

export function usePermission(
  accountId: string | undefined,
  action: string,
  target?: UsePermissionTarget,
): UsePermissionResult {
  const { user } = useAuth();
  const userId = user?.id;

  const query = useQuery({
    queryKey: [
      'iam-permission',
      accountId,
      userId,
      action,
      target?.resourceType ?? null,
      target?.resourceId ?? null,
    ],
    queryFn: () =>
      probeEffectivePermission(accountId!, userId!, {
        action,
        resourceType: target?.resourceType,
        resourceId: target?.resourceId,
      }),
    enabled: !!accountId && !!userId,
    // Permissions change rarely; cache for the SPA's lifetime so route
    // transitions don't refetch. React Query still revalidates on focus.
    staleTime: 5 * 60_000,
  });

  return {
    allowed: query.data?.allowed === true,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
