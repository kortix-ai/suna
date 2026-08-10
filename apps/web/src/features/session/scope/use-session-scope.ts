'use client';

import {
  getWorkspaceSessionScope,
  listConnections,
  listConnectors,
  listWorkspaceSecrets,
  setWorkspaceSessionScope,
  type WorkspaceAdminConnector,
  type Connection,
  type WorkspaceSecret,
  type SessionScopeInput,
} from '@kortix/sdk';
import { qk, useWorkspaceConfig } from '@kortix/sdk/react';
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  buildSessionScopeSelectionCatalog,
  type SessionScopeCatalogState,
  type SessionScopeRawCatalogs,
  type SessionScopeSelectionCatalog,
} from './session-scope-model';

interface SessionScopeCatalogSources {
  listSecrets(workspaceId: string): Promise<readonly WorkspaceSecret[]>;
  listConnectors(workspaceId: string): Promise<readonly WorkspaceAdminConnector[]>;
  listConnections(workspaceId: string): Promise<readonly Connection[]>;
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
  workspaceId: string | null | undefined;
  sessionId?: string | null;
  agentName?: string | null;
}

const sdkCatalogSources: SessionScopeCatalogSources = {
  listSecrets: async (workspaceId) => (await listWorkspaceSecrets(workspaceId)).items,
  listConnectors: async (workspaceId) => (await listConnectors(workspaceId)).connectors,
  listConnections: async (workspaceId) => (await listConnections(workspaceId)).connections,
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
  workspaceId: string | null | undefined,
  sessionId: string | null | undefined,
) {
  return ['workspace-session-scope', workspaceId, sessionId] as const;
}

export function sessionScopeCatalogQueryKey(workspaceId: string | null | undefined) {
  return ['session-scope-catalog', workspaceId] as const;
}

export async function loadSessionScopeCatalog(
  workspaceId: string,
  sources: SessionScopeCatalogSources = sdkCatalogSources,
): Promise<LoadedSessionScopeCatalog> {
  const [secretsResult, connectorsResult, connectionsResult] = await Promise.allSettled([
    sources.listSecrets(workspaceId),
    sources.listConnectors(workspaceId),
    sources.listConnections(workspaceId),
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

export function useSessionScope({ workspaceId, sessionId, agentName }: UseSessionScopeInput) {
  const queryClient = useQueryClient();
  const workspaceConfig = useWorkspaceConfig(workspaceId);
  // useWorkspaceConfig now rides the shared qk.workspace.detail(id) entry (a
  // `select` projection, not its own key) — track fetch/error state on THAT
  // key, not the retired standalone ['workspace-config', id] slot.
  const workspaceConfigKey = qk.workspace.detail(workspaceId ?? '');
  const workspaceConfigFetches = useIsFetching({
    queryKey: workspaceConfigKey,
    exact: true,
  });
  const workspaceConfigState = queryClient.getQueryState(workspaceConfigKey);
  const needsWorkspaceConfig = Boolean(workspaceId && agentName);
  const workspaceConfigStateError =
    workspaceConfigState?.status === 'error' ? workspaceConfigState.error : null;
  const workspaceConfigError = useMemo(() => {
    if (!needsWorkspaceConfig || workspaceConfigState?.status !== 'error') return null;
    return workspaceConfigStateError instanceof Error
      ? workspaceConfigStateError
      : new Error('The workspace configuration request failed.');
  }, [needsWorkspaceConfig, workspaceConfigState?.status, workspaceConfigStateError]);
  const workspaceConfigLoading =
    needsWorkspaceConfig &&
    !workspaceConfig &&
    !workspaceConfigError &&
    (workspaceConfigFetches > 0 ||
      workspaceConfigState === undefined ||
      workspaceConfigState.status === 'pending');

  const scopeQuery = useQuery({
    queryKey: sessionScopeQueryKey(workspaceId, sessionId),
    queryFn: () => getWorkspaceSessionScope(workspaceId as string, sessionId as string),
    enabled: Boolean(workspaceId && sessionId),
    retry: false,
    staleTime: 0,
  });
  const catalogQuery = useQuery({
    queryKey: sessionScopeCatalogQueryKey(workspaceId),
    queryFn: () => loadSessionScopeCatalog(workspaceId as string),
    enabled: Boolean(workspaceId),
    retry: false,
    staleTime: 30_000,
  });

  const catalog = useMemo(() => {
    if (!catalogQuery.data) return undefined;
    if (workspaceConfigError) return unavailableCatalog();
    if (workspaceConfigLoading) return undefined;

    const agentScope = workspaceConfig?.agents.find((agent) => agent.name === agentName)?.scope;
    return buildSessionScopeSelectionCatalog({
      ...catalogQuery.data.raw,
      grants: {
        secrets: agentScope?.env,
        connectors: agentScope?.connectors,
      },
    });
  }, [agentName, catalogQuery.data, workspaceConfig, workspaceConfigError, workspaceConfigLoading]);

  const saveScope = useMutation({
    mutationFn: (replacement: SessionScopeInput) => {
      if (!workspaceId || !sessionId) {
        throw new Error('A workspace and session are required to save session scope.');
      }
      return setWorkspaceSessionScope(workspaceId, sessionId, replacement);
    },
    onSuccess: (scope) => {
      queryClient.setQueryData(sessionScopeQueryKey(workspaceId, sessionId), scope);
    },
  });

  const scopeError = scopeQuery.error instanceof Error ? scopeQuery.error : null;
  const catalogError =
    workspaceConfigError ??
    (catalogQuery.error instanceof Error ? catalogQuery.error : null) ??
    firstCatalogError(catalogQuery.data?.errors);
  const saveError = saveScope.error instanceof Error ? saveScope.error : null;

  return {
    scope: scopeQuery.data,
    catalog,
    saveScope,
    isScopeLoading: scopeQuery.isLoading,
    isCatalogLoading: catalogQuery.isLoading || workspaceConfigLoading,
    isLoading: scopeQuery.isLoading || catalogQuery.isLoading || workspaceConfigLoading,
    scopeError,
    catalogError,
    catalogErrors: catalogQuery.data?.errors,
    saveError,
    error: scopeError ?? catalogError,
  };
}
