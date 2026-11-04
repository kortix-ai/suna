/**
 * Every read the `/providers` screen needs, through the one `kortix()` client
 * and the SDK's react hooks: the live catalogue, the project's secrets, the
 * pooled accounts, model access, the managed models, the viewer and the
 * project's members. The web Models page reads the same sources.
 */

import {
  type AccountSecretResource,
  type LlmProviderCatalogSource,
  type LlmProviderEntry,
  buildLlmProviderCatalog,
  providerIdsWithCredentials,
} from '@kortix/sdk';
import {
  qk,
  refreshProjectProviderState,
  useAccountSecretResources,
  useCan,
  useFeatureFlag,
  useModelAccess,
  useProjectModelPickerCatalog,
  useProjectSecrets,
} from '@kortix/sdk/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { kortix } from '../../kortix.ts';
import { managedProviderEntry } from './providers-model.ts';

export interface ProvidersMember {
  userId: string;
  email: string | null;
  accountRole: string;
}

export interface ProvidersData {
  loading: boolean;
  error: string | null;
  catalogue: LlmProviderEntry[];
  managed: LlmProviderEntry | null;
  byId: Map<string, LlmProviderEntry>;
  /** `providerIdsWithCredentials` of the project's secret names. Empty when the caller cannot read secrets. */
  connectedIds: Set<string>;
  pooled: boolean;
  accountId: string | null;
  accounts: AccountSecretResource[];
  /** When the account list was read, for cooldown deadlines. */
  accountsReadAt: number;
  pooledIds: Set<string>;
  disabledProviders: Set<string>;
  defaultProvider: string | undefined;
  viewerId: string | undefined;
  viewerEmail: string | undefined;
  members: ProvidersMember[];
  /** `project.secret.write`: may save project keys and share connections. */
  canWrite: boolean;
  setProviderEnabled(providerId: string, enabled: boolean): Promise<unknown>;
  accessUpdating: boolean;
  /** Re-read everything a connection changes: secrets, accounts, the model picker. */
  refresh(expectProviderId?: string): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Could not load providers.';
}

export function useProviders(projectId: string, accountIdHint: string | null): ProvidersData {
  const queryClient = useQueryClient();

  const catalogueQuery = useQuery({
    queryKey: ['tui', 'llm-catalog-providers', projectId],
    queryFn: () => kortix().project(projectId).llmCatalogProviders(),
    staleTime: 60 * 60_000,
  });
  const catalogue = useMemo(
    () => (catalogueQuery.data ? buildLlmProviderCatalog(catalogueQuery.data as LlmProviderCatalogSource) : []),
    [catalogueQuery.data],
  );

  const canWriteProbe = useCan({ projectId }, 'project.secret.write');
  const canRead = useCan({ projectId }, 'project.secret.read');
  // A member without project.secret.read gets 403 here; their project keys are unknown.
  const secrets = useProjectSecrets(canRead.allowed === false ? null : projectId);
  const connectedIds = useMemo(() => {
    const items = secrets.data?.items ?? [];
    return providerIdsWithCredentials(catalogue, new Set(items.filter((item) => item.configured !== false).map((item) => item.name)));
  }, [secrets.data, catalogue]);

  const access = useModelAccess(projectId);
  const pickerCatalog = useProjectModelPickerCatalog(projectId);
  const managed = useMemo(
    () => (pickerCatalog ? managedProviderEntry(pickerCatalog.models as Record<string, { name?: string; enabled?: boolean }>) : null),
    [pickerCatalog],
  );

  const pooledFlag = useFeatureFlag(projectId, 'pooled_provider_secrets');
  const membership = useQuery({
    queryKey: ['tui', 'project-access', projectId],
    queryFn: () => kortix().project(projectId).access.list(),
    retry: false,
  });
  const viewer = useQuery({
    queryKey: ['tui', 'viewer'],
    queryFn: () => kortix().validateToken(),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const accountId = membership.data?.account_id ?? accountIdHint;
  const accountsQuery = useAccountSecretResources(pooledFlag.enabled ? accountId : null, projectId);
  const accounts = accountsQuery.data?.secrets ?? [];
  const pooledIds = useMemo(
    () => new Set(accounts.filter((secret) => secret.can_use && secret.active).flatMap((secret) => (secret.provider_id ? [secret.provider_id] : []))),
    [accounts],
  );

  const members = useMemo<ProvidersMember[]>(
    () =>
      (membership.data?.members ?? []).map((member) => ({
        userId: member.user_id,
        email: member.email,
        accountRole: member.account_role,
      })),
    [membership.data],
  );

  const refresh = useCallback(
    async (expectProviderId?: string) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) }),
        queryClient.invalidateQueries({ queryKey: ['account-secret-resources'] }),
        queryClient.invalidateQueries({ queryKey: ['claude-subscription', projectId] }),
        queryClient.invalidateQueries({ queryKey: ['session-provider-secret-pools'] }),
      ]);
      refreshProjectProviderState(queryClient, projectId, expectProviderId ? { expectProviderId } : {});
    },
    [queryClient, projectId],
  );

  const loading =
    catalogueQuery.isLoading || pooledFlag.isLoading || (pooledFlag.enabled && Boolean(accountId) && accountsQuery.isLoading);
  const error = catalogueQuery.isError
    ? errorMessage(catalogueQuery.error)
    : pooledFlag.enabled && accountsQuery.isError
      ? 'Provider secrets could not be loaded.'
      : null;

  return {
    loading,
    error,
    catalogue,
    managed,
    byId: useMemo(() => {
      const map = new Map(catalogue.map((entry) => [entry.id, entry]));
      if (managed) map.set('kortix', managed);
      return map;
    }, [catalogue, managed]),
    connectedIds,
    pooled: pooledFlag.enabled,
    accountId,
    accounts,
    accountsReadAt: accountsQuery.dataUpdatedAt,
    pooledIds,
    disabledProviders: useMemo(() => new Set(access.data?.disabledProviders ?? []), [access.data]),
    defaultProvider: access.defaultProvider,
    viewerId: membership.data?.viewer_user_id ?? viewer.data?.identity?.user_id,
    viewerEmail: viewer.data?.identity?.email,
    members,
    canWrite: canWriteProbe.allowed === true,
    setProviderEnabled: (providerId, enabled) => access.setEnabled({ target: 'provider', id: providerId, enabled }),
    accessUpdating: access.isUpdating,
    refresh,
  };
}
