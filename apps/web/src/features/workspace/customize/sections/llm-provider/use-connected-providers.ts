'use client';

import { useRuntimeProviders } from '@/hooks/runtime/use-runtime-sessions';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { LLM_PROVIDERS, type LlmProviderEntry, type LlmProviderModel } from '@/lib/llm-providers';
import { getProjectDetail, listProjectSecrets } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  CODEX_AUTH_JSON_SECRET_NAME,
  LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME,
  MANAGED_MODEL_ID_SET,
} from './constants';
import {
  buildClaudeSubscriptionProvider,
  buildCodexProvider,
  buildCustomRestProvider,
} from './utils';

export function useConnectedProviders(projectId: string, enabled: boolean) {
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
  // into the LLM Gateway. Native Runtime projects should show only providers
  // backed by project secrets, even if an old running sandbox still exposes a
  // stale `kortix` provider.
  const { data: ocProviders } = useRuntimeProviders();

  const kortixProvider = useMemo<LlmProviderEntry | null>(() => {
    if (!llmGatewayEnabled) return null;
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
        p.id !== 'kortix' && p.envVars.length > 0 && p.envVars.every((v) => secretNames.has(v)),
    );
    const subscription = hasCodexSubscription ? [buildCodexProvider(ocProviders)] : [];
    const claude = buildClaudeSubscriptionProvider(secretNames);
    const claudeSubscription: LlmProviderEntry[] = claude ? [claude] : [];
    const custom = buildCustomRestProvider(secretNames);
    const customProvider: LlmProviderEntry[] = custom ? [custom] : [];
    return kortixProvider
      ? [kortixProvider, ...subscription, ...claudeSubscription, ...customProvider, ...byo]
      : [...subscription, ...claudeSubscription, ...customProvider, ...byo];
  }, [secretNames, kortixProvider, ocProviders]);

  return { secretsQuery, connectedProviders, llmGatewayEnabled };
}
