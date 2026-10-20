'use client';

import { isLlmGatewayEnabled } from '../../../internal/lib/llm-gateway';
import { LLM_PROVIDERS, type LlmProviderEntry } from '../../../internal/lib/llm-providers';
import { isProviderAuthSatisfied } from '@kortix/llm-catalog';
import { getProjectDetail, listProjectSecrets } from '@kortix/sdk';
import { useUiHostConfig } from '../../../providers/ui-provider';
import { contract, qk, useRuntimeProviders } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useTranslations } from '../../../i18n';
import { PROJECT_ACTIONS } from '../../../internal/lib/project-actions';
import { useProjectCan } from '../../../internal/lib/use-project-can';
import {
  CODEX_AUTH_JSON_SECRET_NAME,
  LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME,
  MANAGED_MODEL_ID_SET,
} from './constants';
import { isProviderStateLoading } from './provider-loading-state';
import { useLlmProviderCatalogRevision } from './use-live-catalog';
import { buildCodexProvider, buildKortixManagedProvider } from './utils';

export function useConnectedProviders(projectId: string, enabled: boolean) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // Re-renders this hook when LlmCatalogBootstrap's fetch lands (module
  // bindings are reassigned, not mutated — a plain memo dependency array
  // won't otherwise notice). See use-live-catalog.ts.
  const catalogRevision = useLlmProviderCatalogRevision();
  const projectDetailQuery = useQuery({
    queryKey: qk.project.detail(projectId),
    queryFn: () => getProjectDetail(projectId),
    ...contract('config'),
    enabled,
  });
  const llmGatewayEnabled = isLlmGatewayEnabled(projectDetailQuery.data?.project);

  // A member without project.secret.read gets 403 for this read. Skip it once
  // the probe says so; project keys are then unknown to this caller, and the
  // pooled connections they may use are listed separately.
  const secretRead = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_SECRET_READ);
  const secretsQuery = useQuery({
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
    enabled: enabled && secretRead.allowed !== false,
  });

  const secretNames = useMemo(() => {
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return new Set(items.map((item) => item.name));
  }, [secretsQuery.data]);

  // The managed Kortix gateway exists only for projects that explicitly opt
  // into the LLM Gateway. Native OpenCode projects should show only providers
  // backed by project secrets, even if an old running sandbox still exposes a
  // stale `kortix` provider.
  const runtimeProvidersQuery = useRuntimeProviders();
  const { managedModelsEnabled } = useUiHostConfig();
  const { data: ocProviders } = runtimeProvidersQuery;

  const kortixProvider = useMemo<LlmProviderEntry | null>(() => {
    // CLOUD-ONLY: the served catalog already excludes every managed model on a
    // self-host (KORTIX_MANAGED_PROVIDER_ENABLED off), which would leave this
    // entry with `models: []` — check the public flag directly so the
    // "Managed · Included with your plan" row simply doesn't render instead of
    // showing a managed provider with zero models.
    if (!llmGatewayEnabled || !managedModelsEnabled) return null;
    // The builder also refuses the cloud state the flag cannot see: a plan-gated
    // catalog serving ZERO managed models (free tier with no servable platform
    // default — KRTX-1482) is not a connected managed provider. The model picker
    // shows "No models available — Upgrade" over the same catalog; the Providers
    // tab must not claim the opposite.
    return buildKortixManagedProvider(ocProviders, MANAGED_MODEL_ID_SET, tI18nComplete.raw('texte0a770200f93'));
  }, [llmGatewayEnabled, ocProviders, tI18nComplete]);

  const connectedProviders = useMemo(() => {
    const hasCodexSubscription =
      secretNames.has(CODEX_AUTH_JSON_SECRET_NAME) ||
      secretNames.has(LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME);
    const byo = LLM_PROVIDERS.filter(
      (p) =>
        p.id !== 'kortix' && isProviderAuthSatisfied(p.authRequirement, (v) => secretNames.has(v)),
    );
    const subscription = hasCodexSubscription
      ? [buildCodexProvider(ocProviders, tI18nComplete)]
      : [];
    return kortixProvider ? [kortixProvider, ...subscription, ...byo] : [...subscription, ...byo];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalogRevision drives a re-read of the module-level LLM_PROVIDERS binding, not a value used directly here
  }, [secretNames, kortixProvider, ocProviders, catalogRevision]);

  const providerStateLoading = isProviderStateLoading({
    projectDetailLoading: projectDetailQuery.isLoading,
    secretsLoading: secretsQuery.isLoading,
    secretsSettledOnce: secretsQuery.isFetched,
  });

  return { secretsQuery, connectedProviders, llmGatewayEnabled, providerStateLoading };
}
