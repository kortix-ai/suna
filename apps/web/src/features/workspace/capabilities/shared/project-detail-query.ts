'use client';

import { getProjectDetail } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';

/**
 * How long `['project-detail', projectId]` stays fresh for a capability page.
 *
 * `staleTime` is per-observer, not per-key, so three pages reading one key with
 * three different values is three different answers to "when does a server-side
 * change reach the user". It drifted once already: Skills and Commands read at
 * 10s while Connectors read at 60s, so flipping `connectors_api_discover` took
 * six times longer to show up on the page the flag actually gates.
 */
export const PROJECT_DETAIL_STALE_MS = 10_000;

/**
 * The one `useQuery` argument object for a project's detail. Every capability
 * page passes this verbatim, so the key, the fetcher and the freshness window
 * cannot disagree between them.
 */
export function projectDetailQuery(projectId: string) {
  return {
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: PROJECT_DETAIL_STALE_MS,
    refetchOnMount: true,
  };
}

/**
 * The owning account id, read off the detail every capability surface already
 * loads — the hint `useProjectCan` wants.
 *
 * Without it `useProjectCan` resolves the account through its OWN
 * `getProject` under `['project', projectId]`, and keeps the IAM probe
 * `enabled: false` until that lands. That is two costs on every capability
 * page: a second network call for a project the page is already holding, and
 * a serialized `getProject → probe → canWrite` waterfall, so every write
 * affordance (`+`, Connect, Remove) appears two round-trips after paint
 * rather than one.
 *
 * Reading `['project-detail', projectId]` here is free: the pages mount that
 * observer anyway, so this shares the cache entry instead of adding a fetch.
 * Modals that do not already read it (`ConnectorModal`, `EntityModal`) mount a
 * second observer on the SAME key, which react-query dedupes.
 */
export function useProjectAccountId(projectId: string | undefined): string | undefined {
  const { data } = useQuery({
    ...projectDetailQuery(projectId ?? ''),
    enabled: Boolean(projectId),
  });
  return data?.project?.account_id;
}
