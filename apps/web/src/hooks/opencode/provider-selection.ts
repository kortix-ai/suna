import type { ProviderListResponse as SdkProviderListResponse } from '@kortix/sdk/opencode-client';

import type { ProjectLlmCatalogResponse } from '@kortix/sdk/projects-client';
import { LLM_PROVIDERS } from '@/lib/llm-providers';

export type ProviderListResponse = SdkProviderListResponse;

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

export function mergeProviderLists(
  primary: ProviderListResponse,
  secondary: ProviderListResponse,
): ProviderListResponse {
  const a = normalizeProviderList(primary);
  const b = normalizeProviderList(secondary);
  const all = new Map<string, NonNullable<ProviderListResponse['all']>[number]>();
  for (const provider of Array.isArray(a.all) ? a.all : []) all.set(provider.id, provider);
  for (const provider of Array.isArray(b.all) ? b.all : []) all.set(provider.id, provider);
  const connected = new Set<string>();
  for (const id of Array.isArray(a.connected) ? a.connected : []) connected.add(id);
  for (const id of Array.isArray(b.connected) ? b.connected : []) connected.add(id);
  return {
    ...a,
    all: [...all.values()],
    connected: [...connected],
    default: { ...(a.default ?? {}), ...(b.default ?? {}) },
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
  for (const provider of LLM_PROVIDERS) {
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

/**
 * The minimal shape of a `GET /projects/:id/secrets` list item this module
 * needs — `configured` (a SHARED row exists) and `effective_source` (what
 * resolves for the viewer: their own active PRIVATE override, the shared
 * row, or nothing). Both are computed per-viewer by the API.
 */
export interface SecretUsabilityItem {
  name: string;
  configured: boolean;
  effective_source: 'mine' | 'shared' | 'none';
}

/**
 * Env-var KEYS actually usable in the VIEWER's own sessions: either a shared
 * (project-wide) row is configured, or the viewer has their own active
 * private override. Mirrors gateway resolution (`getResolvedProjectSecretValue`
 * — shared wins, falls back to the caller's own private key). Deliberately
 * NOT "any row exists for this name" — a row owned by a DIFFERENT member is
 * invisible to both the viewer's sessions and this computation, exactly like
 * gateway resolution. Using raw name-presence here is the bug behind the
 * "provider shows connected but every turn 400s" BYOK incident: a lingering
 * private-only row from someone else made every viewer see "Connected".
 */
export function usableSecretNamesForViewer(items: SecretUsabilityItem[]): Set<string> {
  const usable = new Set<string>();
  for (const item of items) {
    if (item.configured || item.effective_source === 'mine') usable.add(item.name);
  }
  return usable;
}

/**
 * Env-var KEYS usable ONLY via the viewer's own private override — no shared
 * row exists, so no other project member's sessions can use it.
 */
export function privateOnlySecretNamesForViewer(items: SecretUsabilityItem[]): Set<string> {
  const privateOnly = new Set<string>();
  for (const item of items) {
    if (!item.configured && item.effective_source === 'mine') privateOnly.add(item.name);
  }
  return privateOnly;
}

/**
 * Connected provider ids whose credential is usable by the viewer ONLY
 * through their own private override — i.e. every env var resolves for the
 * viewer, but at least one of them isn't shared. Drives the "sessions can't
 * use this key — make it shared" warning.
 */
export function privateOnlyProviderIdsFromSecretNames(
  usableNames: Set<string>,
  privateOnlyNames: Set<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const provider of LLM_PROVIDERS) {
    if (provider.id === 'kortix' || provider.envVars.length === 0) continue;
    const allUsable = provider.envVars.every((envVar) => usableNames.has(envVar));
    const anyPrivateOnly = provider.envVars.some((envVar) => privateOnlyNames.has(envVar));
    if (allUsable && anyPrivateOnly) ids.add(provider.id);
  }
  return ids;
}

export function projectLlmCatalogToProviderList(
  catalog: ProjectLlmCatalogResponse,
): ProviderListResponse {
  const models = catalog.models ?? {};
  const firstModelId = Object.keys(models)[0];
  return {
    default: firstModelId ? { kortix: models.auto ? 'auto' : firstModelId } : {},
    connected: ['kortix'],
    all: [{
      id: 'kortix',
      name: 'Kortix',
      source: 'gateway',
      models,
    }],
  } as unknown as ProviderListResponse;
}
