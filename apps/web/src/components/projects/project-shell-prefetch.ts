'use client';

/**
 * Warm shell reads after access succeeds, before lazy children mount.
 * Speculating before that verdict bursts 404s for deleted URLs (KRTX-2759).
 */

import type { QueryClient } from '@tanstack/react-query';

import {
  getProjectDetail,
  getProjectModelPicker,
  getProjectSandboxHealth,
  listProjectSessionsPage,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';

import { SANDBOX_HEALTH_QUERY_KEY } from '@kortix/ui/workspace/sidebar/footer/sandbox-health';

/**
 * Fire the project shell's detail/sessions/sandbox-health/model-picker reads
 * for `projectId` after the access check succeeds. Fire-and-forget, never throws.
 */
export function prefetchProjectShellReads(queryClient: QueryClient, projectId: string): void {
  if (!projectId) return;

  // An entry that already settled as error WITHOUT data belongs to the
  // contract's retry policy, not to this prefetch: a prefetch refetches an
  // errored entry unconditionally, so every navigation to a project the
  // boundary denies re-asked a final 404 — the gone screen's second source of
  // the KRTX-2436 refetch loop (the mounted hooks' interval and `retryOnMount`
  // are fixed in `contract()` itself). Remounting hooks decide instead: a
  // transient error retries on mount, a gone answer (404/410) stands down.
  const detailState = queryClient.getQueryState(qk.project.detail(projectId));
  if (!(detailState?.status === 'error' && detailState.data === undefined)) {
    void queryClient.prefetchQuery({
      queryKey: qk.project.detail(projectId),
      queryFn: () => getProjectDetail(projectId),
      ...contract('config'),
    });
    void queryClient.prefetchQuery({
      queryKey: qk.project.modelPicker(projectId),
      queryFn: () => getProjectModelPicker(projectId),
      ...contract('config'),
    });
  }

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
