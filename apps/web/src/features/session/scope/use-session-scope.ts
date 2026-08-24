'use client';

import {
  getProjectSessionScope,
  listConnections,
  listConnectors,
  listProjectSecrets,
  setProjectSessionScope,
  type AdminConnector,
  type Connection,
  type ProjectSecret,
  type SessionScopeInput,
} from '@kortix/sdk';
import { contract, qk, useProjectConfig } from '@kortix/sdk/react';
import {
  useIsFetching,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';

import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectPageCans } from '@/lib/use-project-can';

import {
  buildSessionScopeSelectionCatalog,
  type SessionScopeCatalogState,
  type SessionScopeRawCatalogs,
  type SessionScopeSelectionCatalog,
} from './session-scope-model';

interface SessionScopeCatalogSources {
  listSecrets(projectId: string): Promise<readonly ProjectSecret[]>;
  listConnectors(projectId: string): Promise<readonly AdminConnector[]>;
  listConnections(projectId: string): Promise<readonly Connection[]>;
}

export interface SessionScopeCatalogErrors {
  secrets: Error | null;
  connectors: Error | null;
  connections: Error | null;
}

export interface LoadedSessionScopeCatalog {
  raw: SessionScopeRawCatalogs;
  errors: SessionScopeCatalogErrors;
}

export interface UseSessionScopeInput {
  projectId: string | null | undefined;
  sessionId?: string | null;
  agentName?: string | null;
}

/**
 * Which catalog axes the CALLER is allowed to read. Secrets and connectors are
 * manager-tier leaves (`project.secret.read`, `project.connector.read`), so for
 * a project `member` both requests are a guaranteed 403.
 *
 * `Promise.allSettled` already degraded those to `status: 'unavailable'`, so the
 * UI was correct — but it was correct by way of two failed HTTP requests on
 * every project-home load, which is noise in the network panel, noise in the
 * API's error logs, and a permission check performed by asking the server to
 * refuse. Ask the permission probe instead and never send the request.
 *
 * `connections` is deliberately absent: `project.connector.connections` is in
 * the member baseline and that call returns 200 for a member.
 */
export interface SessionScopeCatalogPermits {
  secrets: boolean;
  connectors: boolean;
}

const ALL_CATALOG_PERMITS: SessionScopeCatalogPermits = { secrets: true, connectors: true };

/** A request that was never made. Distinct from a request that FAILED: it
 *  yields the same 'unavailable' state but carries no error, so
 *  `firstCatalogError` stays quiet and nothing surfaces a phantom failure. */
const SKIPPED = Symbol('skipped-catalog-axis');
type MaybeSkipped<T> = readonly T[] | typeof SKIPPED;

export function createSessionScopeCatalogSources(
  queryClient: QueryClient,
  fetchSecrets: typeof listProjectSecrets = listProjectSecrets,
): SessionScopeCatalogSources {
  return {
    listSecrets: async (projectId) =>
      (
        await queryClient.fetchQuery({
          queryKey: qk.project.secrets(projectId),
          queryFn: () => fetchSecrets(projectId),
          ...contract('config'),
        })
      ).items,
    listConnectors: async (projectId) => (await listConnectors(projectId)).connectors,
    listConnections: async (projectId) => (await listConnections(projectId)).connections,
  };
}

function rejectedCatalogError(axis: string, reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(`The ${axis} catalog request failed: ${String(reason)}`);
}

function settledCatalogState<T>(
  axis: string,
  result: PromiseSettledResult<MaybeSkipped<T>>,
): { state: SessionScopeCatalogState<T>; error: Error | null } {
  if (result.status === 'fulfilled') {
    // Not permitted → never requested. Same state the 403 used to produce, with
    // no error attached, because nothing went wrong.
    if (result.value === SKIPPED) return { state: { status: 'unavailable' }, error: null };
    return {
      state: { status: 'ready', items: result.value },
      error: null,
    };
  }
  return {
    state: { status: 'unavailable' },
    error: rejectedCatalogError(axis, result.reason),
  };
}

export function sessionScopeQueryKey(
  projectId: string | null | undefined,
  sessionId: string | null | undefined,
) {
  return ['project-session-scope', projectId, sessionId] as const;
}

/** The permits are PART OF THE KEY. They change the result, so a cache slot
 *  that ignored them would keep serving "unavailable" to a user who was just
 *  granted the leaf, until the entry went stale on its own. */
export function sessionScopeCatalogQueryKey(
  projectId: string | null | undefined,
  permits: SessionScopeCatalogPermits = ALL_CATALOG_PERMITS,
) {
  return ['session-scope-catalog', projectId, permits.secrets, permits.connectors] as const;
}

export async function loadSessionScopeCatalog(
  projectId: string,
  sources: SessionScopeCatalogSources,
  permits: SessionScopeCatalogPermits = ALL_CATALOG_PERMITS,
): Promise<LoadedSessionScopeCatalog> {
  const [secretsResult, connectorsResult, connectionsResult] = await Promise.allSettled([
    permits.secrets
      ? sources.listSecrets(projectId)
      : Promise.resolve(SKIPPED as MaybeSkipped<ProjectSecret>),
    permits.connectors
      ? sources.listConnectors(projectId)
      : Promise.resolve(SKIPPED as MaybeSkipped<AdminConnector>),
    sources.listConnections(projectId),
  ]);
  const secrets = settledCatalogState('secret', secretsResult);
  const connectors = settledCatalogState('connector', connectorsResult);
  const connections = settledCatalogState('connection', connectionsResult);

  return {
    raw: {
      secrets: secrets.state,
      connectors: connectors.state,
      connections: connections.state,
    },
    errors: {
      secrets: secrets.error,
      connectors: connectors.error,
      connections: connections.error,
    },
  };
}

function firstCatalogError(errors: SessionScopeCatalogErrors | undefined): Error | null {
  if (!errors) return null;
  return errors.secrets ?? errors.connectors ?? errors.connections;
}

const unavailableCatalog = (): SessionScopeSelectionCatalog => ({
  secrets: { status: 'unavailable' },
  connector_connections: { status: 'unavailable' },
});

export function useSessionScope({ projectId, sessionId, agentName }: UseSessionScopeInput) {
  const queryClient = useQueryClient();
  const catalogSources = useMemo(
    () => createSessionScopeCatalogSources(queryClient),
    [queryClient],
  );
  const projectConfig = useProjectConfig(projectId);
  // useProjectConfig now rides the shared qk.project.detail(id) entry (a
  // `select` projection, not its own key) — track fetch/error state on THAT
  // key, not the retired standalone ['project-config', id] slot.
  const projectConfigKey = qk.project.detail(projectId ?? '');
  const projectConfigFetches = useIsFetching({
    queryKey: projectConfigKey,
    exact: true,
  });
  const projectConfigState = queryClient.getQueryState(projectConfigKey);
  const needsProjectConfig = Boolean(projectId && agentName);
  const projectConfigStateError =
    projectConfigState?.status === 'error' ? projectConfigState.error : null;
  const projectConfigError = useMemo(() => {
    if (!needsProjectConfig || projectConfigState?.status !== 'error') return null;
    return projectConfigStateError instanceof Error
      ? projectConfigStateError
      : new Error('The project configuration request failed.');
  }, [needsProjectConfig, projectConfigState?.status, projectConfigStateError]);
  const projectConfigLoading =
    needsProjectConfig &&
    !projectConfig &&
    !projectConfigError &&
    (projectConfigFetches > 0 ||
      projectConfigState === undefined ||
      projectConfigState.status === 'pending');

  const scopeQuery = useQuery({
    queryKey: sessionScopeQueryKey(projectId, sessionId),
    queryFn: () => getProjectSessionScope(projectId as string, sessionId as string),
    enabled: Boolean(projectId && sessionId),
    retry: false,
    staleTime: 0,
  });
  // Ask ONCE for both leaves (useProjectCans batches into a single probe), then
  // only request the axes this user may actually read.
  const catalogCaps = useProjectPageCans(projectId ?? undefined);
  const secretsCap = catalogCaps[PROJECT_ACTIONS.PROJECT_SECRET_READ];
  const connectorsCap = catalogCaps[PROJECT_ACTIONS.PROJECT_CONNECTOR_READ];
  const catalogPermits = useMemo<SessionScopeCatalogPermits>(
    () => ({ secrets: secretsCap?.allowed === true, connectors: connectorsCap?.allowed === true }),
    [secretsCap?.allowed, connectorsCap?.allowed],
  );
  // Hold the query until the probe answers. Running it early would fetch with
  // `{secrets:false, connectors:false}` (the hook's loading default), cache that
  // under its own key, and then refetch — turning one request into two.
  const catalogPermitsResolved = !secretsCap?.isLoading && !connectorsCap?.isLoading;

  const catalogQuery = useQuery({
    queryKey: sessionScopeCatalogQueryKey(projectId, catalogPermits),
    queryFn: () => loadSessionScopeCatalog(projectId as string, catalogSources, catalogPermits),
    enabled: Boolean(projectId) && catalogPermitsResolved,
    retry: false,
    staleTime: 30_000,
  });

  const catalog = useMemo(() => {
    if (!catalogQuery.data) return undefined;
    if (projectConfigError) return unavailableCatalog();
    if (projectConfigLoading) return undefined;

    const agentScope = projectConfig?.agents.find((agent) => agent.name === agentName)?.scope;
    return buildSessionScopeSelectionCatalog({
      ...catalogQuery.data.raw,
      grants: {
        secrets: agentScope?.env,
        connectors: agentScope?.connectors,
      },
    });
  }, [agentName, catalogQuery.data, projectConfig, projectConfigError, projectConfigLoading]);

  const saveScope = useMutation({
    mutationFn: (replacement: SessionScopeInput) => {
      if (!projectId || !sessionId) {
        throw new Error('A project and session are required to save session scope.');
      }
      return setProjectSessionScope(projectId, sessionId, replacement);
    },
    onSuccess: (scope) => {
      queryClient.setQueryData(sessionScopeQueryKey(projectId, sessionId), scope);
    },
  });

  const scopeError = scopeQuery.error instanceof Error ? scopeQuery.error : null;
  const catalogError =
    projectConfigError ??
    (catalogQuery.error instanceof Error ? catalogQuery.error : null) ??
    firstCatalogError(catalogQuery.data?.errors);
  const saveError = saveScope.error instanceof Error ? saveScope.error : null;

  return {
    scope: scopeQuery.data,
    catalog,
    saveScope,
    isScopeLoading: scopeQuery.isLoading,
    isCatalogLoading: catalogQuery.isLoading || projectConfigLoading,
    isLoading: scopeQuery.isLoading || catalogQuery.isLoading || projectConfigLoading,
    scopeError,
    catalogError,
    catalogErrors: catalogQuery.data?.errors,
    saveError,
    error: scopeError ?? catalogError,
  };
}
