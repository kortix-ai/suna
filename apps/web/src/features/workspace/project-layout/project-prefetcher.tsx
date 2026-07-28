'use client';

/**
 * Warms every surface that is one click away from the project shell.
 *
 * Clicking Files used to sit on a spinner for seconds because it is a
 * WATERFALL: the browser first has to fetch branches to learn the git ref, and
 * only then can it list the tree. Nothing was in flight until the click, so the
 * user paid for both round trips in series. Same story for Automations,
 * Connectors, Secrets and Members — each screen started from cold.
 *
 * This fires those requests once, in parallel, as soon as the shell mounts, so
 * by the time anything is clicked the answer is already in the cache. Each
 * prefetch is best-effort: a 403 for a section the viewer cannot open is
 * expected and simply leaves that entry unwarmed.
 *
 * Prefetch only reads. Anything that costs money, boots a sandbox, or mutates
 * belongs nowhere near this file.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { fetchBranches } from '@/features/project-files/api/branches';
import { listFiles } from '@/features/project-files/api/runtime-files';
import { branchKeys } from '@/features/project-files/hooks/use-branches';
import { fileListKeys } from '@/features/project-files/hooks/use-file-list';
import { getProjectDetail, listProjectSecrets, listProjectTriggers } from '@kortix/sdk';

/** Long enough that a click minutes later still hits cache, short enough to stay true. */
const WARM_STALE_MS = 5 * 60_000;
/** Survive navigating away and back without a refetch. */
const WARM_GC_MS = 30 * 60_000;

export function ProjectPrefetcher({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;

    /** Never let a prefetch failure surface — this is opportunistic. */
    const warm = <T,>(queryKey: readonly unknown[], queryFn: () => Promise<T>) =>
      queryClient
        .prefetchQuery({
          queryKey,
          queryFn,
          staleTime: WARM_STALE_MS,
          gcTime: WARM_GC_MS,
          retry: false,
        })
        .catch(() => {
          /* 403 for a section this viewer cannot open, or offline. */
        });

    // Independent, so fire them together rather than in sequence.
    void warm(['project-detail', projectId], () => getProjectDetail(projectId));
    void warm(['project-triggers', projectId], () => listProjectTriggers(projectId));
    void warm(['project-secrets', projectId], () => listProjectSecrets(projectId));

    // Files is the waterfall: resolve the ref first, then immediately list the
    // root with it, so the click pays for neither hop.
    void (async () => {
      try {
        const branches = await queryClient.fetchQuery({
          queryKey: branchKeys.list(projectId),
          queryFn: () => fetchBranches(projectId),
          staleTime: WARM_STALE_MS,
          gcTime: WARM_GC_MS,
          retry: false,
        });
        if (cancelled) return;
        const ref = branches?.default_branch || branches?.branches?.[0]?.name;
        if (!ref) return;
        await warm(fileListKeys.dir(projectId, ref, '/'), () => listFiles(projectId, ref, '/'));
      } catch {
        /* Files stays cold; the page still loads it on demand. */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, queryClient]);

  return null;
}

export default ProjectPrefetcher;
