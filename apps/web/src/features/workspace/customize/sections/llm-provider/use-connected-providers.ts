'use client';

import {
  CHATGPT_SUBSCRIPTION_PROVIDER,
  CLAUDE_SUBSCRIPTION_PROVIDER,
  LLM_PROVIDER_BY_ID,
  type LlmProviderEntry,
  type LlmProviderModel,
} from '@/lib/llm-providers';
import { getProjectLlmCatalog, type HarnessAuthKind } from '@kortix/sdk/projects-client';
import { useHarnessConnections } from '@kortix/sdk/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { CUSTOM_LLM_SECRET_NAMES, MANAGED_MODEL_ID_SET } from './constants';

function customRestProvider(): LlmProviderEntry {
  return {
    id: 'custom-rest',
    label: 'Custom REST provider',
    envVars: [...CUSTOM_LLM_SECRET_NAMES],
    helpUrl: null,
    hint: 'OpenAI- or Anthropic-compatible endpoint',
    models: [],
    featured: false,
  };
}

const CONNECTION_PROVIDER: Partial<Record<HarnessAuthKind, () => LlmProviderEntry | null>> = {
  claude_subscription: () => CLAUDE_SUBSCRIPTION_PROVIDER,
  codex_subscription: () => CHATGPT_SUBSCRIPTION_PROVIDER,
  anthropic_api_key: () => LLM_PROVIDER_BY_ID.get('anthropic') ?? null,
  openai_api_key: () => LLM_PROVIDER_BY_ID.get('openai') ?? null,
  openai_compatible: customRestProvider,
  anthropic_compatible: customRestProvider,
};

export function useConnectedProviders(projectId: string, enabled: boolean) {
  const connectionsQuery = useHarnessConnections(enabled ? projectId : null);
  const catalogQuery = useQuery({
    queryKey: ['project-llm-catalog', projectId],
    queryFn: () => getProjectLlmCatalog(projectId),
    staleTime: 30_000,
    enabled,
  });

  const readyConnections = useMemo(
    () => connectionsQuery.data?.connections.filter((connection) => connection.ready) ?? [],
    [connectionsQuery.data?.connections],
  );
  const llmGatewayEnabled = readyConnections.some(
    (connection) => connection.id === 'managed_gateway',
  );

  const kortixProvider = useMemo<LlmProviderEntry | null>(() => {
    if (!llmGatewayEnabled) return null;
    const models: LlmProviderModel[] = Object.entries(catalogQuery.data?.models ?? {})
      .filter(([id]) => MANAGED_MODEL_ID_SET.has(id))
      .map(([id, model]) => ({ id, name: model.name || id, released: null }));
    return {
      id: 'kortix',
      label: 'Kortix',
      envVars: [],
      helpUrl: null,
      hint: 'Included with your plan',
      models,
      featured: true,
      managed: true,
    };
  }, [catalogQuery.data?.models, llmGatewayEnabled]);

  const connectedProviders = useMemo(() => {
    const providers: LlmProviderEntry[] = kortixProvider ? [kortixProvider] : [];
    const seen = new Set(providers.map((provider) => provider.id));
    for (const connection of readyConnections) {
      const provider = CONNECTION_PROVIDER[connection.kind]?.() ?? null;
      if (!provider || seen.has(provider.id)) continue;
      seen.add(provider.id);
      providers.push(provider);
    }
    for (const configured of connectionsQuery.data?.providers ?? []) {
      const provider = LLM_PROVIDER_BY_ID.get(configured.provider_id);
      if (!provider || seen.has(provider.id)) continue;
      seen.add(provider.id);
      providers.push(provider);
    }
    return providers;
  }, [connectionsQuery.data?.providers, kortixProvider, readyConnections]);

  return { connectionsQuery, connectedProviders, llmGatewayEnabled };
}
