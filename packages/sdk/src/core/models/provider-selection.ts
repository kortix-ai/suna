import {
  CATALOG_PROVIDER_ENV,
  type ProviderAuthRequirement,
  isProviderAuthSatisfied,
  providerAuthRequirement,
  generationControlCapabilities,
} from '@kortix/llm-catalog/lite';
import type { ProviderListResponse as SdkProviderListResponse } from '../runtime/runtime-types';

import type {
  ProjectLlmCatalogProvidersResponse,
  ProjectLlmCatalogResponse,
} from '../rest/projects-client';

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
 *
 * Reads `CATALOG_PROVIDER_ENV` (the catalog's `{ id, env }` projection), not
 * `CATALOG`: this module is in every browser route's graph, and `CATALOG` is
 * the full ~7.6 MB models.dev snapshot.
 */
export const LLM_PROVIDER_CREDENTIALS: Array<{
  id: string;
  authRequirement: ProviderAuthRequirement;
}> = CATALOG_PROVIDER_ENV.map((provider) => ({
  id: provider.id,
  authRequirement: providerAuthRequirement(provider),
}));

// OpenCode must see Kortix as the single LLM provider: the LLM gateway is the
// only model path.
export const GATEWAY_PROVIDER_IDS = new Set(['kortix']);

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

/**
 * @deprecated The LLM gateway is the only model path, so no picker shows a
 * native provider list. Drops the `kortix` provider. Removed in the next major.
 */
export function filterToNativeProviders(providers: ProviderListResponse): ProviderListResponse {
  const normalized = normalizeProviderList(providers);
  const all = Array.isArray(normalized.all) ? normalized.all : [];
  const connected = Array.isArray(normalized.connected) ? normalized.connected : [];
  return {
    ...normalized,
    all: all.filter((p) => !GATEWAY_PROVIDER_IDS.has(p.id)),
    connected: connected.filter((id) => !GATEWAY_PROVIDER_IDS.has(id)),
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
    Object.entries(catalog.models ?? {})
      .filter(([modelId]) => modelId !== 'auto' && modelId !== 'kortix/auto')
      .map(([modelId, model]) => {
        // The gateway picker never carried `variants`, so the composer's
        // Thinking control (which lists `Object.keys(model.variants)`) had
        // nothing to offer on-gateway — the ONLY effort path there was a
        // project-level routing-policy write. Derive the ids from the same
        // `reasoning_options` the API already serves, through the same
        // `generationControlCapabilities` the gateway's own clamp uses, so
        // the picker offers exactly the tiers a request may carry. An
        // explicit `variants` map from the API (runtime truth) is kept as-is.
        if (model.variants && Object.keys(model.variants).length > 0) return [modelId, model];
        const ids = generationControlCapabilities({
          id: modelId,
          name: model.name,
          reasoning: model.reasoning,
          reasoning_options: model.reasoning_options,
        }).reasoningEffort?.values;
        if (!ids?.length) return [modelId, model];
        return [modelId, { ...model, variants: Object.fromEntries(ids.map((id) => [id, {}])) }];
      }),
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

/** The raw sources a project composer's model picker is built from. */
export interface PickerProviderListInput {
  /** @deprecated Ignored: the LLM gateway is the only model path. Removed in the next major. */
  gatewayEnabled?: boolean;
  /** `GET /projects/:id/model-picker`. */
  modelPicker?: ProjectLlmCatalogResponse;
  /** @deprecated Ignored: the native picker source is gone. Removed in the next major. */
  runtimeProviders?: ProviderListResponse;
  /** @deprecated Ignored: the native picker source is gone. Removed in the next major. */
  llmCatalogProviders?: ProjectLlmCatalogProvidersResponse;
  /** @deprecated Ignored: the native picker source is gone. Removed in the next major. */
  secretNames?: Set<string>;
}

/**
 * The provider list a project composer's model picker renders — the same
 * source `useRuntimeProviders` reads: the `/model-picker` catalog as the
 * single `kortix` provider (`auto` dropped, per-model `enabled` kept). Feed
 * the result to `flattenModels(list)`.
 *
 * `undefined` = nothing loaded yet.
 */
export function pickerProviderList(input: PickerProviderListInput): ProviderListResponse | undefined {
  return input.modelPicker ? projectLlmCatalogToProviderList(input.modelPicker) : undefined;
}
