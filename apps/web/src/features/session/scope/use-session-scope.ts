'use client';

import {
  getProjectSessionScope,
  listConnectorAuthorizations,
  listConnectors,
  listProjectSecrets,
  setProjectSessionScope,
  type AdminConnector,
  type ConnectorAuthorization,
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
  listAuthorizations(projectId: string): Promise<readonly ConnectorAuthorization[]>;
}

export interface SessionScopeCatalogErrors {
  secrets: Error | null;
  connectors: Error | null;
  authorizations: Error | null;
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
  listAuthorizations: async (projectId) => (await listConnectorAuthorizations(projectId)).profiles,
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
  const [secretsResult, connectorsResult, authorizationsResult] = await Promise.allSettled([
    sources.listSecrets(projectId),
    sources.listConnectors(projectId),
    sources.listAuthorizations(projectId),
  ]);
  const secrets = settledCatalogState('secret', secretsResult);
  const connectors = settledCatalogState('connector profile', connectorsResult);
  const authorizations = settledCatalogState('connector authorization', authorizationsResult);

  return {
    raw: {
      secrets: secrets.state,
      connectors: connectors.state,
      authorizations: authorizations.state,
    },
    errors: {
      secrets: secrets.error,
      connectors: connectors.error,
      authorizations: authorizations.error,
    },
  };
}

function firstCatalogError(errors: SessionScopeCatalogErrors | undefined): Error | null {
  if (!errors) return null;
  return errors.secrets ?? errors.connectors ?? errors.authorizations;
}

const unavailableCatalog = (): SessionScopeSelectionCatalog => ({
  secrets: { status: 'unavailable' },
  connector_profiles: { status: 'unavailable' },
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
