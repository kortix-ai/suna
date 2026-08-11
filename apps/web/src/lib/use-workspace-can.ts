'use client';

/**
 * useWorkspaceCan — per-action capability gating for a PROJECT, for the current
 * user. The workspace analogue of `usePermission`: instead of branching on the
 * coarse `effective_workspace_role === 'manager'` label, it probes the IAM engine
 * for the exact leaf action a route asserts (e.g. project.gitops.push), so a
 * custom role that DEACTIVATES one capability is reflected in the UI precisely.
 *
 * Rides the existing `usePermission`/`usePermissions` probe (no new endpoint):
 * a workspace-scoped probe `{ action, resourceType: 'workspace', resourceId }`.
 * The accountId the probe needs is resolved from the shared react-query cache of
 * the workspace itself (`qk.workspace.summary(workspaceId)`), so callers pass only
 * workspaceId.
 *
 * NOT a security boundary — the API re-checks every mutating route via
 * assertProjectCapability. This only decides what to show/enable. Probes are
 * cached 5min with no revoke-invalidation, so a just-changed role may lag until
 * the cache expires (consistent with usePermission).
 */

import type { PermissionProbeInput, PermissionProbeTarget } from '@/lib/iam-client';
import { usePermission, usePermissions, type UsePermissionResult } from '@/lib/use-permission';
import { getWorkspace } from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

export function workspacePermissionTarget(
  workspaceId: string | undefined,
): Extract<PermissionProbeTarget, { resourceType: 'workspace' }> | undefined {
  if (!workspaceId) return undefined;
  return { resourceType: 'workspace', resourceId: workspaceId };
}

export function workspacePermissionProbes(
  workspaceId: string | undefined,
  actions: readonly string[],
): PermissionProbeInput[] {
  const target = workspacePermissionTarget(workspaceId);
  return target ? actions.map((action) => ({ action, ...target })) : [];
}

/**
 * Resolve the owning account id. Callers that already hold it (e.g. a screen
 * that loaded the workspace under a DIFFERENT query key like qk.workspace.detail(id))
 * should pass `accountIdHint` — that skips the extra getWorkspace round-trip AND,
 * more importantly, lets the IAM probe run on the FIRST render instead of being
 * disabled while a second fetch resolves. Without the hint we fall back to the
 * shared qk.workspace.summary(workspaceId) cache.
 */
function useWorkspaceAccountId(
  workspaceId: string | undefined,
  accountIdHint?: string,
): string | undefined {
  const { data } = useQuery({
    queryKey: qk.workspace.summary(workspaceId ?? ''),
    queryFn: () => getWorkspace(workspaceId!),
    // Don't even fire the query when the caller already handed us the account.
    enabled: !!workspaceId && !accountIdHint,
    ...contract('config'),
  });
  return workspaceId ? (accountIdHint ?? data?.account_id) : undefined;
}

/**
 * Coerce a probe result to "still loading" while the prerequisite accountId is
 * unresolved. A react-query query that is DISABLED (here: because accountId is
 * not known yet) reports `isLoading === false` in v5 — so a naive caller would
 * see `allowed:false, isLoading:false` and wrongly conclude "denied". Treating
 * the unresolved window as loading keeps the hide-by-default / optimistic-while-
 * loading contract intact.
 */
function pendingWhileUnresolved(
  result: UsePermissionResult,
  resolved: boolean,
): UsePermissionResult {
  return resolved ? result : { allowed: false, reason: null, isLoading: true, isError: false };
}

/** Can the current user perform `action` on this workspace? Defaults to
 *  `allowed: false` (with `isLoading: true`) until the workspace/probe resolves. */
export function useWorkspaceCan(
  workspaceId: string | undefined,
  action: string,
  options?: { accountId?: string },
): UsePermissionResult {
  const accountId = useWorkspaceAccountId(workspaceId, options?.accountId);
  const target = workspacePermissionTarget(workspaceId);
  const resolved = !!accountId && !!target;
  const result = usePermission(resolved ? accountId : undefined, action, target);
  return pendingWhileUnresolved(result, resolved);
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
export function useWorkspaceCans(
  workspaceId: string | undefined,
  actions: readonly string[],
  options?: { accountId?: string },
): Record<string, UsePermissionResult> {
  const accountId = useWorkspaceAccountId(workspaceId, options?.accountId);
  const resolved = !!accountId && !!workspaceId;
  const probes = useMemo<PermissionProbeInput[]>(
    () => workspacePermissionProbes(workspaceId, actions),
    [actions, workspaceId],
  );
  const results = usePermissions(resolved ? accountId : undefined, probes);
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
