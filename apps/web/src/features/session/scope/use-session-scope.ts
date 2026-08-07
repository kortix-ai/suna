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
import { qk, useProjectConfig } from '@kortix/sdk/react';
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

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

const sdkCatalogSources: SessionScopeCatalogSources = {
  listSecrets: async (projectId) => (await listProjectSecrets(projectId)).items,
  listConnectors: async (projectId) => (await listConnectors(projectId)).connectors,
  listConnections: async (projectId) => (await listConnections(projectId)).connections,
};

function rejectedCatalogError(axis: string, reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new Error(`The ${axis} catalog request failed: ${String(reason)}`);
}

function settledCatalogState<T>(
  axis: string,
  result: PromiseSettledResult<readonly T[]>,
): { state: SessionScopeCatalogState<T>; error: Error | null } {
  if (result.status === 'fulfilled') {
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

export function sessionScopeCatalogQueryKey(projectId: string | null | undefined) {
  return ['session-scope-catalog', projectId] as const;
}

export async function loadSessionScopeCatalog(
  projectId: string,
  sources: SessionScopeCatalogSources = sdkCatalogSources,
): Promise<LoadedSessionScopeCatalog> {
  const [secretsResult, connectorsResult, connectionsResult] = await Promise.allSettled([
    sources.listSecrets(projectId),
    sources.listConnectors(projectId),
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
  const catalogQuery = useQuery({
    queryKey: sessionScopeCatalogQueryKey(projectId),
    queryFn: () => loadSessionScopeCatalog(projectId as string),
    enabled: Boolean(projectId),
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
