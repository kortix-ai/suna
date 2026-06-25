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

import { getProject } from '@/lib/projects-client';
import { usePermission, usePermissions, type UsePermissionResult } from '@/lib/use-permission';
import type { PermissionProbeInput } from '@/lib/iam-client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

/** Resolve the owning account id from the cached project (shares the cache the
 *  rest of the project UI already populates — a hit in practice). */
function useProjectAccountId(projectId: string | undefined): string | undefined {
  const { data } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId!),
    enabled: !!projectId,
    staleTime: 60_000,
  });
  return data?.account_id;
}

/** Can the current user perform `action` on this project? Defaults to
 *  `allowed: false` while the project/probe is loading (hide-by-default). */
export function useProjectCan(projectId: string | undefined, action: string): UsePermissionResult {
  const accountId = useProjectAccountId(projectId);
  return usePermission(accountId, action, { resourceType: 'project', resourceId: projectId });
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
): Record<string, UsePermissionResult> {
  const accountId = useProjectAccountId(projectId);
  const probes = useMemo<PermissionProbeInput[]>(
    () => actions.map((action) => ({ action, resourceType: 'project' as const, resourceId: projectId })),
    [actions, projectId],
  );
  const results = usePermissions(accountId, probes);
  return useMemo(() => {
    const map: Record<string, UsePermissionResult> = {};
    actions.forEach((action, i) => {
      map[action] = results[i];
    });
    return map;
  }, [actions, results]);
}
