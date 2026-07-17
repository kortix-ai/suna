'use client';

import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { isManagedProviderEnabled } from '@/lib/config';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { LLM_PROVIDERS, type LlmProviderEntry, type LlmProviderModel } from '@/lib/llm-providers';
import { isProviderAuthSatisfied } from '@kortix/llm-catalog';
import { getProjectDetail, listProjectSecrets } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  CODEX_AUTH_JSON_SECRET_NAME,
  LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME,
  MANAGED_MODEL_ID_SET,
} from './constants';
import { useLlmProviderCatalogRevision } from './use-live-catalog';
import { buildCodexProvider } from './utils';

export function useConnectedProviders(projectId: string, enabled: boolean) {
  // Re-renders this hook when LlmCatalogBootstrap's fetch lands (module
  // bindings are reassigned, not mutated — a plain memo dependency array
  // won't otherwise notice). See use-live-catalog.ts.
  const catalogRevision = useLlmProviderCatalogRevision();
  const projectDetailQuery = useQuery({
    queryKey: ['project-detail', projectId],
    queryFn: () => getProjectDetail(projectId),
    staleTime: 30_000,
    enabled,
  });
  const llmGatewayEnabled = isLlmGatewayEnabled(projectDetailQuery.data?.project);

  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 10_000,
    enabled,
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
  const { data: ocProviders } = useOpenCodeProviders();

  const kortixProvider = useMemo<LlmProviderEntry | null>(() => {
    // CLOUD-ONLY: the served catalog already excludes every managed model on a
    // self-host (KORTIX_MANAGED_PROVIDER_ENABLED off), which would leave this
    // entry with `models: []` — check the public flag directly so the
    // "Managed · Included with your plan" row simply doesn't render instead of
    // showing a managed provider with zero models.
    if (!llmGatewayEnabled || !isManagedProviderEnabled()) return null;
    const connectedIds = new Set(ocProviders?.connected ?? []);
    const kortix = (ocProviders?.all ?? []).find((p) => p.id === 'kortix');
    if (!kortix || !connectedIds.has('kortix')) return null;
    const models: LlmProviderModel[] = Object.entries(kortix.models ?? {})
      .filter(([id]) => MANAGED_MODEL_ID_SET.has(id))
      .map(([id, m]) => ({
        id,
        name: ((m as { name?: string }).name || id).replace('(latest)', '').trim(),
        released: (m as { release_date?: string }).release_date ?? null,
      }));
    return {
      id: 'kortix',
      label: kortix.name || 'Kortix',
      envVars: [],
      authRequirement: { methods: [] },
      helpUrl: null,
      hint: 'Included with your plan',
      models,
      featured: true,
      managed: true,
    };
  }, [llmGatewayEnabled, ocProviders]);

  const connectedProviders = useMemo(() => {
    const hasCodexSubscription =
      secretNames.has(CODEX_AUTH_JSON_SECRET_NAME) ||
      secretNames.has(LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME);
    const byo = LLM_PROVIDERS.filter(
      (p) =>
        p.id !== 'kortix' && isProviderAuthSatisfied(p.authRequirement, (v) => secretNames.has(v)),
    );
    const subscription = hasCodexSubscription ? [buildCodexProvider(ocProviders)] : [];
    return kortixProvider ? [kortixProvider, ...subscription, ...byo] : [...subscription, ...byo];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- catalogRevision drives a re-read of the module-level LLM_PROVIDERS binding, not a value used directly here
  }, [secretNames, kortixProvider, ocProviders, catalogRevision]);

  return { secretsQuery, connectedProviders, llmGatewayEnabled };
}
