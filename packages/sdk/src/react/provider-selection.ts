import type { ProviderListResponse as SdkProviderListResponse } from '@opencode-ai/sdk/v2/client';
import { CATALOG } from '@kortix/shared/llm-catalog';

import type { ProjectLlmCatalogResponse } from '../platform/projects-client';

export type ProviderListResponse = SdkProviderListResponse;

/**
 * Provider → credential env-var mapping, derived from the shared models.dev
 * catalog. Mirrors the `{ id, envVars }` projection of the web's `LLM_PROVIDERS`
 * (which is itself built from the same catalog), so connection inference is
 * identical without depending on the web-only provider-modal catalog module.
 */
export const LLM_PROVIDER_CREDENTIALS: Array<{ id: string; envVars: string[] }> =
  CATALOG.providers.map((provider) => ({
    id: provider.id,
    envVars: provider.env ?? [],
  }));

// In gateway mode OpenCode must see Kortix as the single LLM provider. Native
// providers, including OpenCode Zen, belong only to native mode.
export const GATEWAY_PROVIDER_IDS = new Set(['kortix']);
const NATIVE_EXCLUDED_PROVIDER_IDS = new Set(['kortix']);

export function normalizeProviderList(
  providers: ProviderListResponse,
): ProviderListResponse {
  const modernAll = Array.isArray(providers.all) ? providers.all : [];
  const modernConnected = Array.isArray(providers.connected) ? providers.connected : [];
  if (modernAll.length > 0 || modernConnected.length > 0) {
    return {
      ...providers,
      all: modernAll,
      connected: modernConnected,
    };
  }

  const legacyProviders = Array.isArray((providers as any).providers)
    ? (providers as any).providers
    : [];
  if (legacyProviders.length === 0) {
    return {
      ...providers,
      all: [],
      connected: [],
    };
  }

  return {
    ...providers,
    all: legacyProviders,
    connected: legacyProviders.map((provider: { id: string }) => provider.id),
  } as ProviderListResponse;
}

/**
 * True when a provider-list response actually carries usable models — i.e. at
 * least one CONNECTED provider that exposes >=1 model. A response failing this
 * is a transient boot state, not a real answer.
 */
export function providerListHasModels(providers: ProviderListResponse | undefined): boolean {
  if (!providers) return false;
  const normalized = normalizeProviderList(providers);
  const all = Array.isArray(normalized.all) ? normalized.all : [];
  const connected = Array.isArray(normalized.connected) ? normalized.connected : [];
  if (connected.length === 0) return false;
  return all.some(
    (p) =>
      connected.includes(p.id) &&
      p.models &&
      Object.keys(p.models).length > 0,
  );
}

export function providerListHasGateway(providers: ProviderListResponse | undefined): boolean {
  if (!providers) return false;
  const normalized = normalizeProviderList(providers);
  const all = Array.isArray(normalized.all) ? normalized.all : [];
  const connected = Array.isArray(normalized.connected) ? normalized.connected : [];
  return connected.includes('kortix') || all.some((p) => p.id === 'kortix');
}

export function filterToGatewayProviders(providers: ProviderListResponse): ProviderListResponse {
  const normalized = normalizeProviderList(providers);
  const all = Array.isArray(normalized.all) ? normalized.all : [];
  const connected = Array.isArray(normalized.connected) ? normalized.connected : [];
  return {
    ...normalized,
    all: all.filter((p) => GATEWAY_PROVIDER_IDS.has(p.id)),
    connected: connected.filter((id) => GATEWAY_PROVIDER_IDS.has(id)),
  };
}

export function filterToNativeProviders(providers: ProviderListResponse): ProviderListResponse {
  const normalized = normalizeProviderList(providers);
  const all = Array.isArray(normalized.all) ? normalized.all : [];
  const connected = Array.isArray(normalized.connected) ? normalized.connected : [];
  return {
    ...normalized,
    all: all.filter((p) => !NATIVE_EXCLUDED_PROVIDER_IDS.has(p.id)),
    connected: connected.filter((id) => !NATIVE_EXCLUDED_PROVIDER_IDS.has(id)),
  };
}

export function mergeProjectSecretConnectedProviders(
  providers: ProviderListResponse,
  secretNames: Set<string>,
  providerCredentials: Array<{ id: string; envVars: string[] }>,
): ProviderListResponse {
  const normalized = normalizeProviderList(providers);
  const all = Array.isArray(normalized.all) ? normalized.all : [];
  const allIds = new Set(all.map((provider) => provider.id));
  const connected = new Set(Array.isArray(normalized.connected) ? normalized.connected : []);

  for (const provider of providerCredentials) {
    if (
      allIds.has(provider.id) &&
      provider.envVars.length > 0 &&
      provider.envVars.every((envVar) => secretNames.has(envVar))
    ) {
      connected.add(provider.id);
    }
  }

  if (
    allIds.has('codex') &&
    (secretNames.has('CODEX_AUTH_JSON') || secretNames.has('OPENCODE_AUTH_JSON'))
  ) {
    connected.add('codex');
  }

  return { ...normalized, connected: [...connected] };
}

export function connectedGatewayProviderIdsFromSecretNames(
  secretNames: Set<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const provider of LLM_PROVIDER_CREDENTIALS) {
    if (
      provider.envVars.length > 0 &&
      provider.envVars.every((envVar) => secretNames.has(envVar))
    ) {
      ids.add(provider.id);
    }
  }
  if (secretNames.has('CODEX_AUTH_JSON') || secretNames.has('OPENCODE_AUTH_JSON')) {
    ids.add('codex');
  }
  return ids;
}

export function projectLlmCatalogToProviderList(
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
