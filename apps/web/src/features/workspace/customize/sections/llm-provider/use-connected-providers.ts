'use client';

import {
  privateOnlyProviderIdsFromSecretNames,
  privateOnlySecretNamesForViewer,
  usableSecretNamesForViewer,
} from '@/hooks/opencode/provider-selection';
import { useOpenCodeProviders } from '@/hooks/opencode/use-opencode-sessions';
import { LLM_PROVIDERS, type LlmProviderEntry, type LlmProviderModel } from '@/lib/llm-providers';
import { isManagedProviderEnabled } from '@/lib/config';
import { isLlmGatewayEnabled } from '@/lib/llm-gateway';
import { getProjectDetail, listProjectSecrets } from '@kortix/sdk/projects-client';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  CODEX_AUTH_JSON_SECRET_NAME,
  LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME,
  MANAGED_MODEL_ID_SET,
} from './constants';
import { buildCodexProvider } from './utils';

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

  // `secretNames` used to be "any row exists for this KEY, shared or not" —
  // which is exactly the gap behind the "connected but every turn 400s" BYOK
  // incident: a lingering PRIVATE-only row (owner_user_id set) made a provider
  // look connected to every viewer even though only its owner's OWN sessions
  // can actually use it (see getResolvedProjectSecretValue). Use the same
  // per-viewer usability rule the gateway now applies instead of a blind name
  // match (see provider-selection.ts, unit-tested there).
  const items = useMemo(() => {
    const data = secretsQuery.data;
    return Array.isArray(data) ? data : (data?.items ?? []);
  }, [secretsQuery.data]);
  const secretNames = useMemo(() => usableSecretNamesForViewer(items), [items]);
  const privateOnlyNames = useMemo(() => privateOnlySecretNamesForViewer(items), [items]);

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
        p.id !== 'kortix' &&
        p.envVars.length > 0 &&
        p.envVars.every((v) => secretNames.has(v)),
    );
    const subscription = hasCodexSubscription ? [buildCodexProvider(ocProviders)] : [];
    return kortixProvider ? [kortixProvider, ...subscription, ...byo] : [...subscription, ...byo];
  }, [secretNames, kortixProvider, ocProviders]);

  // A connected provider where at least one env var only resolves via MY
  // private override — nobody else on the project can use it. Drives the
  // "sessions can't use this key — make it shared" warning + one-click fix.
  const privateOnlyProviderIds = useMemo(
    () => privateOnlyProviderIdsFromSecretNames(secretNames, privateOnlyNames),
    [secretNames, privateOnlyNames],
  );

  return { secretsQuery, connectedProviders, llmGatewayEnabled, privateOnlyProviderIds };
}
