import { getProjectDetail } from '@kortix/sdk';

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
  };
}
