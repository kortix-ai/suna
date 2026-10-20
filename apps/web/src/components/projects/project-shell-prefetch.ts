'use client';

/**
 * Warm the shell cache before its lazy children mount. The access boundary
 * calls this only after access succeeds: speculative reads on a deleted URL
 * otherwise turn its single access verdict into a burst of 404s (KRTX-2759).
 */
import type { QueryClient } from '@tanstack/react-query';

import {
  getProjectDetail,
  getProjectModelPicker,
  getProjectSandboxHealth,
  listProjectSessionsPage,
  type ProjectDetail,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

import { SANDBOX_HEALTH_QUERY_KEY } from '@/features/workspace/project-sidebar/footer/sandbox-health';

/**
 * Same rule as `projectDetailLlmGatewayEnabled` (`packages/sdk/src/react/use-
 * project-llm-gateway.ts`), kept local because that SDK predicate is package-internal. Pure, so it is
 * independently testable.
 */
export function gatewayEnabledFromDetail(detail: ProjectDetail | undefined): boolean {
  return detail?.project?.experimental?.llm_gateway === true;
}

/**
 * The real second hop: the model picker only exists for a gateway-enabled
 * project, and that flag lives inside the detail response. `fetchQuery`
 * (not `prefetchQuery`) so this function gets the resolved value back —
 * it still populates the exact same `qk.project.detail(id)` cache entry every
 * other detail reader shares, with the same options, so this is not a second,
 * differently-configured read of the same data.
 */
async function prefetchModelPickerOnceGatewayKnown(
  queryClient: QueryClient,
  projectId: string,
): Promise<void> {
  // An entry that already settled as error WITHOUT data belongs to the
  // contract's retry policy, not to this prefetch: `fetchQuery` refetches an
  // errored entry unconditionally, so every navigation to a project the
  // boundary denies re-asked a final 404 — the gone screen's second source of
  // the KRTX-2436 refetch loop (the mounted hooks' interval and `retryOnMount`
  // are fixed in `contract()` itself). Remounting hooks decide instead: a
  // transient error retries on mount, a gone answer (404/410) stands down.
  const detailState = queryClient.getQueryState(qk.project.detail(projectId));
  if (detailState?.status === 'error' && detailState.data === undefined) return;
  const detail = await queryClient
    .fetchQuery({
      queryKey: qk.project.detail(projectId),
      queryFn: () => getProjectDetail(projectId),
      ...contract('config'),
    })
    .catch(() => undefined);
  if (!gatewayEnabledFromDetail(detail)) return;
  await queryClient
    .prefetchQuery({
      queryKey: qk.project.modelPicker(projectId),
      queryFn: () => getProjectModelPicker(projectId),
      ...contract('config'),
    })
    .catch(() => undefined);
}

/**
 * Fire the project shell's detail/sessions/sandbox-health reads for
 * `projectId` after the access check succeeds, plus the model picker once
 * detail says the project's gateway is on. Fire-and-forget, never throws.
 */
export function prefetchProjectShellReads(queryClient: QueryClient, projectId: string): void {
  if (!projectId) return;

  void prefetchModelPickerOnceGatewayKnown(queryClient, projectId);

  void queryClient.prefetchInfiniteQuery({
    queryKey: qk.project.sessionsPaged(projectId, 'visible'),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      listProjectSessionsPage(projectId, { scope: 'visible', cursor: pageParam }),
    ...contract('inventory'),
  });

  void queryClient.prefetchQuery({
    queryKey: SANDBOX_HEALTH_QUERY_KEY(projectId),
    queryFn: () => getProjectSandboxHealth(projectId),
    staleTime: 30_000,
  });
}
