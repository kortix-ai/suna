/**
 * Every read the `/connectors` screen needs, through the one `kortix()` client:
 * the project's connectors and accounts, the catalogue page for the search,
 * what the viewer may do, and the people, groups and agents an account can be
 * shared with. The web connectors pages read the same sources.
 */

import {
  type AccountGroup,
  type AdminConnector,
  type AgentIdentity,
  type Connection,
  type DiscoverConnector,
  getProjectDetail,
  listGroups,
  listProjectAgentIdentities,
} from '@kortix/sdk';
import { qk, useCan } from '@kortix/sdk/react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { kortix } from '../../kortix.ts';

export interface ShareCandidate {
  kind: 'member' | 'group' | 'agent';
  /** A user id, a group id, or an agent's service account id. */
  id: string;
  label: string;
}

export interface ConnectorsData {
  loading: boolean;
  error: string | null;
  connectors: AdminConnector[];
  /** Undefined until the account list has loaded. */
  connections: Connection[] | undefined;
  catalog: DiscoverConnector[];
  catalogTotal: number;
  catalogLoading: boolean;
  catalogHasMore: boolean;
  loadMoreCatalog(): void;
  accountId: string | null;
  projectName: string | null;
  viewerId: string | undefined;
  viewerEmail: string | undefined;
  /** `project.connector.write`: install and remove connectors. */
  canWrite: boolean;
  /** `project.connector.connections.manage`: share accounts with others. */
  canManageConnections: boolean;
  /** People (minus the viewer), groups, and agents, for "Specific people, groups, or agents". */
  candidates: ShareCandidate[];
  /** Re-read connectors and accounts after a write. */
  refresh(): Promise<void>;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The search the catalogue asks for, 300 ms after the last keystroke (the web's debounce). */
function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function connectionsQueryKey(projectId: string) {
  // The web's key (`['connections', projectId]`), so one cache entry serves both.
  return ['connections', projectId] as const;
}

export function useConnectors(projectId: string, accountIdHint: string | null, search: string): ConnectorsData {
  const queryClient = useQueryClient();
  const project = kortix().project(projectId);

  const connectorsQuery = useQuery({
    queryKey: qk.project.connectors(projectId),
    queryFn: () => project.connectors.list(),
    retry: false,
  });
  const connectionsQuery = useQuery({
    queryKey: connectionsQueryKey(projectId),
    queryFn: () => project.connectors.connections.list(),
    retry: false,
  });

  const q = useDebounced(search.trim(), 300);
  const catalogQuery = useInfiniteQuery({
    queryKey: ['tui', 'discover-connectors', projectId, q],
    queryFn: ({ pageParam }) =>
      project.connectors.discover.list({ ...(q ? { q } : {}), ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.hasMore ? last.nextCursor : undefined),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const membership = useQuery({
    queryKey: ['tui', 'project-access', projectId],
    queryFn: () => project.access.list(),
    retry: false,
  });
  const detail = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    retry: false,
  });
  const viewer = useQuery({
    queryKey: ['tui', 'viewer'],
    queryFn: () => kortix().validateToken(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const accountId = membership.data?.account_id ?? accountIdHint;
  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId as string),
    enabled: Boolean(accountId),
    retry: false,
    staleTime: 60_000,
  });
  const agentsQuery = useQuery({
    queryKey: ['tui', 'project-agent-identities', projectId],
    queryFn: () => listProjectAgentIdentities(projectId),
    retry: false,
    staleTime: 60_000,
  });

  const canWrite = useCan({ projectId }, 'project.connector.write').allowed === true;
  const canManageConnections = useCan({ projectId }, 'project.connector.connections.manage').allowed === true;

  const viewerId = membership.data?.viewer_user_id ?? viewer.data?.identity?.user_id;
  const candidates = useMemo<ShareCandidate[]>(
    () => [
      ...(membership.data?.members ?? [])
        .filter((member) => member.user_id !== viewerId)
        .map((member) => ({ kind: 'member' as const, id: member.user_id, label: member.email ?? member.user_id })),
      ...((groupsQuery.data ?? []) as AccountGroup[]).map((group) => ({
        kind: 'group' as const,
        id: group.group_id,
        label: group.name,
      })),
      ...((agentsQuery.data ?? []) as AgentIdentity[])
        .filter((agent) => agent.project_id === projectId && agent.agent_name)
        .map((agent) => ({ kind: 'agent' as const, id: agent.service_account_id, label: agent.agent_name ?? agent.name })),
    ],
    [membership.data, groupsQuery.data, agentsQuery.data, viewerId, projectId],
  );

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.project.connectors(projectId) }),
      queryClient.invalidateQueries({ queryKey: connectionsQueryKey(projectId) }),
      queryClient.invalidateQueries({ queryKey: ['tui', 'discover-connectors', projectId] }),
    ]);
  }, [queryClient, projectId]);

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = catalogQuery;
  const loadMoreCatalog = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const catalog = useMemo(
    () => (catalogQuery.data?.pages ?? []).flatMap((page) => page.items),
    [catalogQuery.data],
  );

  return {
    loading: connectorsQuery.isLoading,
    error: connectorsQuery.isError ? errorMessage(connectorsQuery.error, 'Could not load connectors.') : null,
    connectors: connectorsQuery.data?.connectors ?? [],
    connections: connectionsQuery.data?.connections,
    catalog,
    catalogTotal: catalogQuery.data?.pages[0]?.total ?? catalog.length,
    catalogLoading: catalogQuery.isLoading || catalogQuery.isFetching,
    catalogHasMore: Boolean(hasNextPage),
    loadMoreCatalog,
    accountId,
    projectName: detail.data?.project?.name ?? null,
    viewerId,
    viewerEmail: viewer.data?.identity?.email,
    canWrite,
    canManageConnections,
    candidates,
    refresh,
  };
}
