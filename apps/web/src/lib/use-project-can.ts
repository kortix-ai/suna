'use client';

/**
 * useProjectCan — per-action capability gating for a PROJECT, for the current
 * user. The project analogue of `usePermission`: instead of branching on the
 * coarse `effective_project_role === 'manager'` label, it probes the IAM engine
 * for the exact leaf action a route asserts (e.g. project.gitops.push), so a
 * custom role that DEACTIVATES one capability is reflected in the UI precisely.
 *
 * Rides the existing `usePermission`/`usePermissions` probe (no new endpoint):
 * a project-scoped probe `{ action, resourceType: 'project', resourceId }`.
 * The accountId the probe needs is resolved from the shared react-query cache of
 * the project itself (`['project', projectId]`), so callers pass only projectId.
 *
 * NOT a security boundary — the API re-checks every mutating route via
 * assertProjectCapability. This only decides what to show/enable. Probes are
 * cached 5min with no revoke-invalidation, so a just-changed role may lag until
 * the cache expires (consistent with usePermission).
 */

import { getProject } from '@kortix/sdk/projects-client';
import { usePermission, usePermissions, type UsePermissionResult } from '@/lib/use-permission';
import type { PermissionProbeInput } from '@/lib/iam-client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

/**
 * Resolve the owning account id. Callers that already hold it (e.g. a screen
 * that loaded the project under a DIFFERENT query key like ['project-detail'])
 * should pass `accountIdHint` — that skips the extra getProject round-trip AND,
 * more importantly, lets the IAM probe run on the FIRST render instead of being
 * disabled while a second fetch resolves. Without the hint we fall back to the
 * shared ['project', projectId] cache.
 */
function useProjectAccountId(
  projectId: string | undefined,
  accountIdHint?: string,
): string | undefined {
  const { data } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    // Don't even fire the query when the caller already handed us the account.
    enabled: !!projectId && !accountIdHint,
    staleTime: 60_000,
  });
  return accountIdHint ?? data?.account_id;
}

/**
 * Coerce a probe result to "still loading" while the prerequisite accountId is
 * unresolved. A react-query query that is DISABLED (here: because accountId is
 * not known yet) reports `isLoading === false` in v5 — so a naive caller would
 * see `allowed:false, isLoading:false` and wrongly conclude "denied". Treating
 * the unresolved window as loading keeps the hide-by-default / optimistic-while-
 * loading contract intact.
 */
function pendingWhileUnresolved(result: UsePermissionResult, resolved: boolean): UsePermissionResult {
  return resolved ? result : { allowed: false, reason: null, isLoading: true, isError: false };
}

/** Can the current user perform `action` on this project? Defaults to
 *  `allowed: false` (with `isLoading: true`) until the project/probe resolves. */
export function useProjectCan(
  projectId: string | undefined,
  action: string,
  options?: { accountId?: string },
): UsePermissionResult {
  const accountId = useProjectAccountId(projectId, options?.accountId);
  const result = usePermission(accountId, action, { resourceType: 'project', resourceId: projectId });
  return pendingWhileUnresolved(result, !!accountId);
}

/**
 * Batch variant — one HTTP roundtrip for N project actions. Returns a map keyed
 * by action string so callers read `caps[ACTION].allowed`. Use this to gate a
 * whole screen (e.g. every customize rail item) in a single probe instead of
 * N hooks.
 *
 * `actions` MUST be stable across renders (declare module-level or wrap in
 * useMemo) — the query keys on the action list.
 */
export function useProjectCans(
  projectId: string | undefined,
  actions: readonly string[],
  options?: { accountId?: string },
): Record<string, UsePermissionResult> {
  const accountId = useProjectAccountId(projectId, options?.accountId);
  const resolved = !!accountId;
  const probes = useMemo<PermissionProbeInput[]>(
    () => actions.map((action) => ({ action, resourceType: 'project' as const, resourceId: projectId })),
    [actions, projectId],
  );
  const results = usePermissions(accountId, probes);
  return useMemo(() => {
    const map: Record<string, UsePermissionResult> = {};
    actions.forEach((action, i) => {
      // Until accountId resolves the probe is disabled (isLoading:false in v5);
      // report it as loading so callers keep their optimistic-while-loading path.
      map[action] = pendingWhileUnresolved(results[i], resolved);
    });
    return map;
  }, [actions, results, resolved]);
}
