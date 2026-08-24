import {
  CATALOG,
  type ProviderAuthRequirement,
  isProviderAuthSatisfied,
  providerAuthRequirement,
} from '@kortix/llm-catalog';
import type { ProviderListResponse as SdkProviderListResponse } from '@opencode-ai/sdk/v2/client';

import type { ProjectLlmCatalogResponse } from '../core/rest/projects-client';

export type ProviderListResponse = SdkProviderListResponse;

/**
 * Provider → Kortix-owned auth requirement, derived from the shared
 * models.dev catalog via `providerAuthRequirement` (NOT the raw catalog
 * `env` list — see that function's doc comment for why: models.dev lists
 * every auth method the upstream SDK supports, not what Kortix actually
 * reads). Mirrors the `{ id, authRequirement }` projection of the web's
 * `LLM_PROVIDERS` (built from the same catalog + the same override table),
 * so connection inference is identical without depending on the web-only
 * provider-modal catalog module.
 */
export const LLM_PROVIDER_CREDENTIALS: Array<{
  id: string;
  authRequirement: ProviderAuthRequirement;
}> = CATALOG.providers.map((provider) => ({
  id: provider.id,
  authRequirement: providerAuthRequirement(provider),
}));

// In gateway mode OpenCode must see Kortix as the single LLM provider. Native
// providers, including OpenCode Zen, belong only to native mode.
export const GATEWAY_PROVIDER_IDS = new Set(['kortix']);
const NATIVE_EXCLUDED_PROVIDER_IDS = new Set(['kortix']);

export function normalizeProviderList(providers: ProviderListResponse): ProviderListResponse {
  const modernAll = Array.isArray(providers.all) ? providers.all : [];
  const modernConnected = Array.isArray(providers.connected) ? providers.connected : [];
  if (modernAll.length > 0 || modernConnected.length > 0) {
    return {
      ...providers,
      all: modernAll,
      connected: modernConnected,
    };
  }

  // Legacy responses carried providers under `.providers` instead of `.all` —
  // not part of the modern `ProviderListResponse` type, so duck-type via
  // `unknown` rather than assume that (long-gone) legacy shape is still real.
  const maybeLegacy = (providers as unknown as { providers?: unknown }).providers;
  const legacyProviders: Array<{ id: string; models?: Record<string, unknown> }> = Array.isArray(
    maybeLegacy,
  )
    ? maybeLegacy
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
    connected: legacyProviders.map((provider) => provider.id),
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
  return all.some((p) => connected.includes(p.id) && p.models && Object.keys(p.models).length > 0);
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
  const first = normalizeProviderList(primary);
  const second = normalizeProviderList(secondary);
  const all = new Map<string, NonNullable<ProviderListResponse['all']>[number]>();
  for (const provider of Array.isArray(first.all) ? first.all : []) {
    all.set(provider.id, provider);
  }
  for (const provider of Array.isArray(second.all) ? second.all : []) {
    all.set(provider.id, provider);
  }
  const connected = new Set<string>();
  for (const id of Array.isArray(first.connected) ? first.connected : []) connected.add(id);
  for (const id of Array.isArray(second.connected) ? second.connected : []) connected.add(id);
  return {
    ...first,
    all: [...all.values()],
    connected: [...connected],
    default: { ...(first.default ?? {}), ...(second.default ?? {}) },
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
  providerCredentials: Array<{ id: string; authRequirement: ProviderAuthRequirement }>,
): ProviderListResponse {
  const normalized = normalizeProviderList(providers);
  const all = Array.isArray(normalized.all) ? normalized.all : [];
  const allIds = new Set(all.map((provider) => provider.id));
  const connected = new Set(Array.isArray(normalized.connected) ? normalized.connected : []);

  for (const provider of providerCredentials) {
    if (
      allIds.has(provider.id) &&
      isProviderAuthSatisfied(provider.authRequirement, (envVar) => secretNames.has(envVar))
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

/**
 * Native mode, BEFORE any sandbox runtime exists: synthesize the picker's
 * provider list from the ungated `/llm-catalog/providers` route plus the
 * project's secret NAMES.
 *
 * OpenCode in the box is the native catalog's source of truth — but on the
 * project home and on a cold session there IS no box yet, and without a
 * pre-runtime source the composer showed "No models available" on every
 * native project until one booted (connecting a key changed nothing). This is
 * the native twin of gateway mode's `/model-picker`, and it deliberately:
 *
 *  • includes ONLY providers whose auth the project's secrets satisfy — the
 *    195-provider catalog would be dead weight `flattenModels` filters out,
 *    and an unconnected provider's models must not be pickable;
 *  • maps the catalog's `released` onto `release_date` (what the flatten and
 *    the picker sort read);
 *  • never emits the synthetic `kortix` provider;
 *  • returns an EMPTY list with no keys, so the connect-provider call to
 *    action stays honest.
 *
 * Once the runtime is up, the live `/provider` list replaces this (it knows
 * auth.json, autoloaded providers like OpenCode Zen, and real capabilities).
 */
export function nativeProviderListFromCatalog(
  catalog: {
    providers: Array<{
      id: string;
      name: string;
      models: Array<{ id: string; name: string; released: string | null }>;
    }>;
  },
  secretNames: Set<string>,
): ProviderListResponse {
  const connectedIds = connectedGatewayProviderIdsFromSecretNames(secretNames);
  const all = (catalog.providers ?? [])
    .filter(
      (provider) =>
        connectedIds.has(provider.id) &&
        !NATIVE_EXCLUDED_PROVIDER_IDS.has(provider.id) &&
        (provider.models?.length ?? 0) > 0,
    )
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      source: 'env',
      models: Object.fromEntries(
        provider.models.map((model) => [
          model.id,
          {
            id: model.id,
            name: model.name,
            ...(model.released ? { release_date: model.released } : {}),
          },
        ]),
      ),
    }));
  return {
    all,
    connected: all.map((provider) => provider.id),
  } as unknown as ProviderListResponse;
}

export function connectedGatewayProviderIdsFromSecretNames(secretNames: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const provider of LLM_PROVIDER_CREDENTIALS) {
    if (isProviderAuthSatisfied(provider.authRequirement, (envVar) => secretNames.has(envVar))) {
      ids.add(provider.id);
    }
  }
  if (secretNames.has('CODEX_AUTH_JSON') || secretNames.has('OPENCODE_AUTH_JSON')) {
    ids.add('codex');
  }
  return ids;
}

/**
 * Restamp `enabled` on a gateway ProviderListResponse from an overrides map
 * (`wireModelId -> enabled`), touching only the models the map names. Pure —
 * returns a new list. Used to optimistically update the cached
 * `['project-providers', :id, 'gateway']` query when "Manage models" writes an
 * override, so the session picker (which renders from THAT cache, staleTime
 * Infinity) reflects the toggle without waiting for the refetch.
 */
export function applyEnablementToProviderList(
  providers: ProviderListResponse,
  overrides: Record<string, boolean>,
): ProviderListResponse {
  const all = Array.isArray(providers.all) ? providers.all : [];
  return {
    ...providers,
    all: all.map((provider) => ({
      ...provider,
      models: Object.fromEntries(
        Object.entries(provider.models ?? {}).map(([id, model]) => [
          id,
          overrides[id] === undefined
            ? model
            : { ...(model as Record<string, unknown>), enabled: overrides[id] },
        ]),
      ),
    })),
  } as unknown as ProviderListResponse;
}

export function projectLlmCatalogToProviderList(
  catalog: ProjectLlmCatalogResponse,
): ProviderListResponse {
  const models = Object.fromEntries(
    Object.entries(catalog.models ?? {}).filter(
      ([modelId]) => modelId !== 'auto' && modelId !== 'kortix/auto',
    ),
  );
  const firstModelId = Object.keys(models)[0];
  return {
    default: firstModelId ? { kortix: firstModelId } : {},
    connected: ['kortix'],
    all: [
      {
        id: 'kortix',
        name: 'Kortix',
        source: 'gateway',
        models,
      },
    ],
  } as unknown as ProviderListResponse;
}
