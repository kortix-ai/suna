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

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/components/AuthProvider';
import {
  probeEffectivePermission,
  probeEffectivePermissions,
  type PermissionProbeInput,
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
  /** Engine's verdict reason: super_admin, policy, legacy_account_role,
   *  legacy_project_role, explicit_deny, no_matching_policy, not_a_member.
   *  Useful for "why does Alice have this?" tooltips on the capabilities panel. */
  reason: string | null;
  isLoading: boolean;
  isError: boolean;
}

/** Shared query factory used by both the current-user and explicit-user
 * variants. Identical queryKey shape so the cache dedupes when the same
 * (user, action, target) is asked from multiple places. */
function useProbeQuery(
  accountId: string | undefined,
  userId: string | undefined,
  action: string,
  target?: UsePermissionTarget,
): UsePermissionResult {
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
    staleTime: 5 * 60_000,
  });

  return {
    allowed: query.data?.allowed === true,
    reason: query.data?.reason ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/** Probe "can the CURRENT user perform this action?" — drives UI gating. */
export function usePermission(
  accountId: string | undefined,
  action: string,
  target?: UsePermissionTarget,
): UsePermissionResult {
  const { user } = useAuth();
  return useProbeQuery(accountId, user?.id, action, target);
}

/** Probe "can THIS member perform this action?" — drives admin views like
 *  the "what can this user actually do" capability panel. Caller must have
 *  member.read on the account (enforced by the backend probe endpoint). */
export function usePermissionFor(
  accountId: string | undefined,
  memberUserId: string | undefined,
  action: string,
  target?: UsePermissionTarget,
): UsePermissionResult {
  return useProbeQuery(accountId, memberUserId, action, target);
}

/**
 * Batch variant — one HTTP roundtrip for N probes. Use when a single
 * component needs more than 3 answers (capability grid, mass button gating
 * on the same screen). Returns one UsePermissionResult per input, in order.
 *
 * The query is keyed by the FULL probe list so adding or removing a probe
 * triggers a refetch. Most callers should keep the probe list stable across
 * renders (declare outside the component or wrap in useMemo).
 */
export function usePermissionsFor(
  accountId: string | undefined,
  memberUserId: string | undefined,
  probes: PermissionProbeInput[],
): UsePermissionResult[] {
  const query = useQuery({
    queryKey: [
      'iam-permission-batch',
      accountId,
      memberUserId,
      // Stable key: action + scope per probe, joined. Avoids serializing
      // unrelated object identity that React refs swap each render.
      probes.map((p) => `${p.action}|${p.resourceType ?? ''}|${p.resourceId ?? ''}`).join(','),
    ],
    queryFn: () => probeEffectivePermissions(accountId!, memberUserId!, probes),
    enabled: !!accountId && !!memberUserId && probes.length > 0,
    staleTime: 5 * 60_000,
  });

  return useMemo(() => {
    const data = query.data;
    return probes.map((_, i) => {
      const hit = data?.[i];
      return {
        allowed: hit?.allowed === true,
        reason: hit?.reason ?? null,
        isLoading: query.isLoading,
        isError: query.isError,
      };
    });
  }, [probes, query.data, query.isLoading, query.isError]);
}

/** Current-user variant of the batch hook — same shape, derives the user
 *  from auth context. */
export function usePermissions(
  accountId: string | undefined,
  probes: PermissionProbeInput[],
): UsePermissionResult[] {
  const { user } = useAuth();
  return usePermissionsFor(accountId, user?.id, probes);
}
