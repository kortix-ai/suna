'use client';

import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { LLM_PROVIDERS, type LlmProviderEntry, type LlmProviderModel } from '@/lib/llm-providers';
import { listProjectSecrets } from '@/lib/projects-client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  CODEX_AUTH_JSON_SECRET_NAME,
  LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME,
  MANAGED_MODEL_ID_SET,
} from './constants';

export function useConnectedProviders(projectId: string, open: boolean) {
  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 10_000,
    enabled: open,
  });

  const secretNames = useMemo(() => {
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return new Set(items.map((item) => item.name));
  }, [secretsQuery.data]);

  const { data: ocProviders } = useOpenCodeProviders();

  const kortixProvider = useMemo<LlmProviderEntry | null>(() => {
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
  }, [ocProviders]);

  const connectedProviders = useMemo(() => {
    const byo = LLM_PROVIDERS.filter(
      (p) =>
        p.id !== 'kortix' &&
        ((p.envVars.length > 0 && p.envVars.every((v) => secretNames.has(v))) ||
          (p.id === 'openai' &&
            (secretNames.has(CODEX_AUTH_JSON_SECRET_NAME) ||
              secretNames.has(LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME)))),
    );
    return kortixProvider ? [kortixProvider, ...byo] : byo;
  }, [secretNames, kortixProvider]);

  return { secretsQuery, connectedProviders };
}
