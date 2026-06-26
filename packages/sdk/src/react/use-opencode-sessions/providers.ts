'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { getClient } from '../../opencode/client';
import { opencodeKeys, useOpenCodeRuntimeReady } from './keys';
import type { ProviderListResponse } from './keys';
import { unwrap, getLSCache, setLSCache, LS_PROVIDERS, CACHE_SCOPE_GLOBAL } from './shared';
import {
  getProjectLlmCatalog,
  type ProjectLlmCatalogResponse,
} from '../../platform/projects-client';

// ============================================================================
// Provider Hooks
// ============================================================================

/**
 * True when a provider-list response actually carries usable models — i.e. at
 * least one CONNECTED provider that exposes ≥1 model. A response failing this
 * is a transient boot state, not a real answer (see useOpenCodeProviders).
 */
function providerListHasModels(providers: ProviderListResponse | undefined): boolean {
  const all = Array.isArray(providers?.all) ? providers!.all : [];
  const connected = Array.isArray(providers?.connected) ? providers!.connected : [];
  if (connected.length === 0) return false;
  return all.some(
    (p) =>
      connected.includes(p.id) &&
      p.models &&
      Object.keys(p.models).length > 0,
  );
}

// Every LLM call must go through the Kortix gateway, which opencode exposes as
// the single `kortix` provider (Codex included, as `codex/<id>` models). Any
// OTHER provider opencode reports is a NATIVE one (a leaked `anthropic`/`openai`
// key) that talks to the provider directly and bypasses the gateway. Drop them
// HERE, at the source, so they never reach the cache or any consumer. `opencode`
// (Zen) is the deliberate exception: its free models route natively too, but
// that's the point — they're free and never touch gateway billing.
export const GATEWAY_PROVIDER_IDS = new Set(['kortix', 'opencode']);

function filterToGatewayProviders(providers: ProviderListResponse): ProviderListResponse {
  const all = Array.isArray(providers.all) ? providers.all : [];
  const connected = Array.isArray(providers.connected) ? providers.connected : [];
  return {
    ...providers,
    all: all.filter((p) => GATEWAY_PROVIDER_IDS.has(p.id)),
    connected: connected.filter((id) => GATEWAY_PROVIDER_IDS.has(id)),
  };
}

function projectLlmCatalogToProviderList(
  catalog: ProjectLlmCatalogResponse,
): ProviderListResponse {
  const models = catalog.models ?? {};
  return {
    default: { kortix: models.auto ? 'auto' : (Object.keys(models)[0] ?? 'auto') },
    connected: ['kortix'],
    all: [{
      id: 'kortix',
      name: 'Kortix',
      source: 'gateway',
      models,
    }],
  } as unknown as ProviderListResponse;
}

export function useOpenCodeProviders() {
  const runtimeReady = useOpenCodeRuntimeReady();
  const params = useParams();
  const projectId = typeof params?.id === 'string' ? params.id : null;
  // BYOK makes the connected model set project-specific (a provider connected
  // in one project must NOT leak into another, nor linger after removal), so
  // the persisted placeholder is scoped per project — not the old global scope.
  const cacheScope = projectId ? `proj:${projectId}` : CACHE_SCOPE_GLOBAL;
  return useQuery<ProviderListResponse>({
    queryKey: projectId ? ['project-llm-catalog', projectId] : opencodeKeys.providers(),
    queryFn: async () => {
      if (projectId) {
        const catalog = await getProjectLlmCatalog(projectId);
        const providers = projectLlmCatalogToProviderList(catalog);
        setLSCache(LS_PROVIDERS, providers, cacheScope);
        return providers;
      }
      const client = getClient();
      const result = await client.provider.list();
      const providers = filterToGatewayProviders(unwrap(result));

      // During sandbox boot the OpenCode server frequently answers
      // /provider/list BEFORE its provider config is wired up, returning zero
      // CONNECTED providers (→ zero models). With staleTime:Infinity such an
      // empty answer would be cached for the whole session and never refetched,
      // AND persisted to the global localStorage cache below — poisoning the
      // first frame of every future session too. That is the "model picker
      // never shows up" bug. Treat a model-less response as a transient boot
      // state: throw so React Query retries it (with backoff), and never cache
      // or persist it.
      if (!providerListHasModels(providers)) {
        throw new Error(
          'opencode provider list has no connected models yet — sandbox still warming up',
        );
      }

      // Persist under the per-project scope (never the ephemeral per-sandbox
      // server id) so a fresh session paints the right models instantly. Only
      // genuine, model-bearing responses reach here, so the placeholder cache
      // is never poisoned with an empty list.
      setLSCache(LS_PROVIDERS, providers, cacheScope);
      return providers;
    },
    // Only ever serve a model-bearing placeholder. A previously-poisoned cache
    // (written before this guard existed) is ignored so it can't paint empty.
    placeholderData: () => {
      const cached = getLSCache<ProviderListResponse>(LS_PROVIDERS, cacheScope);
      if (!providerListHasModels(cached)) return undefined;
      // Old caches may have been persisted before the source filter — clean them
      // on read so a poisoned cache never paints a native provider.
      return filterToGatewayProviders(cached as ProviderListResponse);
    },
    enabled: projectId ? true : runtimeReady,
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    // The boot race (sandbox up, providers not yet wired) self-heals: keep
    // retrying with capped exponential backoff until real models appear.
    retry: (failureCount) => failureCount < 10,
    retryDelay: (attempt) => Math.min(1000 * Math.pow(2, attempt), 8000),
  });
}
