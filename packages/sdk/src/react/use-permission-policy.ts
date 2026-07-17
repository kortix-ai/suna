'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACP_PERMISSION_POLICY_MAX_KEY_LENGTH,
  ACP_PERMISSION_POLICY_MAX_TOOLS,
  getAcpPermissionPolicy,
  putAcpPermissionPolicy,
  type AcpPermissionAutoApprove,
  type AcpPermissionPolicy,
  type AcpPermissionToolDecision,
} from '../core/rest/projects-client';

/** The policy every project resolves to before any write has ever happened —
 *  mirrors the GET route's documented absent-policy default (Task WS5-P1-a,
 *  `apps/api/src/projects/lib/acp-permission-policy.ts`: deny-by-default,
 *  every tool call prompts). Also what this hook returns while the query is
 *  still loading, so a consumer never has to null-check `policy`. */
const DEFAULT_ACP_PERMISSION_POLICY: AcpPermissionPolicy = { autoApprove: 'none', toolDecisions: {} };

/** Stable query-key factory — reuse this to read/invalidate the same cache
 *  entry `usePermissionPolicy` populates (e.g. after an out-of-band write). */
export const permissionPolicyKey = (projectId: string | null | undefined) =>
  ['project', projectId, 'acp-permission-policy'] as const;

/**
 * The project's persistent ACP permission policy (Task WS5-P1-a's
 * `GET`/`PUT /projects/:projectId/acp/permission-policy`) as a React Query
 * binding over `acp-permission-policy.ts`'s client fns.
 *
 * `setAutoApprove`/`rememberToolDecision` write optimistically: the merged
 * next policy is pushed into the cache immediately (so the UI reflects the
 * choice with no round-trip latency), then persisted with a real `PUT`. On
 * success the cache is reconciled with the server's own response (the
 * authoritative copy, in case the server normalized anything). On failure,
 * this package has no existing `onMutate`/`onError` snapshot-rollback
 * mutation to mirror (checked every `react/*.ts` hook — none track a
 * pre-mutation snapshot for manual restore), so this keeps the simplest
 * correct rollback instead of inventing one: **discard the optimistic value
 * by refetching the server's real policy**, and rethrow the error so the
 * caller can surface it (toast, inline message, etc.) — refetch-on-error,
 * not manual snapshot-restore.
 *
 * `rememberToolDecision` also client-side-guards the two caps the server
 * enforces (`ACP_PERMISSION_POLICY_MAX_TOOLS` / `_MAX_KEY_LENGTH`, mirrored
 * from `@kortix/api-contract` in `acp-permission-policy.ts`) so the UI never
 * sends a `PUT` the server is guaranteed to 422 — it rejects locally instead,
 * with no cache mutation and no network call.
 *
 * Query caching mirrors `use-composer-capabilities.ts` with 10s staleTime.
 */
export function usePermissionPolicy(projectId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = permissionPolicyKey(projectId);

  const query = useQuery<AcpPermissionPolicy>({
    queryKey,
    queryFn: () => getAcpPermissionPolicy(projectId as string),
    enabled: !!projectId,
    staleTime: 10_000,
  });

  const policy = query.data ?? DEFAULT_ACP_PERMISSION_POLICY;

  async function persist(next: AcpPermissionPolicy): Promise<void> {
    if (!projectId) return;
    queryClient.setQueryData(queryKey, next);
    try {
      const saved = await putAcpPermissionPolicy(projectId, next);
      queryClient.setQueryData(queryKey, saved);
    } catch (error) {
      // Refetch-on-error: discard the optimistic value with the server's
      // real state rather than hand-tracking a pre-mutation snapshot.
      await queryClient.invalidateQueries({ queryKey });
      throw error;
    }
  }

  function setAutoApprove(mode: AcpPermissionAutoApprove): Promise<void> {
    return persist({ ...policy, autoApprove: mode });
  }

  function rememberToolDecision(tool: string, decision: AcpPermissionToolDecision): Promise<void> {
    if (tool.length > ACP_PERMISSION_POLICY_MAX_KEY_LENGTH) {
      return Promise.reject(
        new Error(`ACP tool name exceeds ${ACP_PERMISSION_POLICY_MAX_KEY_LENGTH} characters: ${tool}`),
      );
    }
    const isNewTool = !(tool in policy.toolDecisions);
    const nextCount = Object.keys(policy.toolDecisions).length + (isNewTool ? 1 : 0);
    if (nextCount > ACP_PERMISSION_POLICY_MAX_TOOLS) {
      return Promise.reject(
        new Error(`ACP permission policy cannot remember more than ${ACP_PERMISSION_POLICY_MAX_TOOLS} tool decisions`),
      );
    }
    return persist({
      ...policy,
      toolDecisions: { ...policy.toolDecisions, [tool]: decision },
    });
  }

  return {
    ...query,
    policy,
    isLoading: query.isLoading,
    setAutoApprove,
    rememberToolDecision,
  };
}
