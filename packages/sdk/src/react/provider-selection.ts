import {
  CATALOG,
  type ProviderAuthRequirement,
  isProviderAuthSatisfied,
  providerAuthRequirement,
  generationControlCapabilities,
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
/**
 * Which model a provider should DEFAULT to when the user has picked nothing.
 * Mirrors the API picker's table (apps/api/src/llm-gateway/models/
 * picker-catalog.ts FLAGSHIP_CANDIDATES) — first candidate present in the
 * catalog wins; a provider not listed (or whose candidates are absent) falls
 * back to its most recently released model. Without this the very first
 * message of a native project ran on whatever model happened to sort first in
 * the models.dev file (observed live: `Hy-MT2-30B-A3B`, which OpenRouter
 * refused with "No endpoints found that support tool use").
 */
const NATIVE_FLAGSHIP_CANDIDATES: Record<string, string[]> = {
  anthropic: ['claude-opus-4-8', 'claude-sonnet-4-6'],
  openai: ['gpt-5.5', 'gpt-5.1', 'gpt-5', 'gpt-4.1'],
  google: ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.0-flash'],
  'x-ai': ['grok-4', 'grok-3'],
  xai: ['grok-4', 'grok-3'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  mistral: ['mistral-large-latest', 'mistral-large'],
  groq: ['llama-3.3-70b-versatile'],
  perplexity: ['sonar-pro', 'sonar'],
  openrouter: ['anthropic/claude-sonnet-4.6', 'anthropic/claude-sonnet-4.5', 'openai/gpt-5.2'],
};

/** Table providers first, in table order — "first connected provider" then
 *  favors a direct flagship provider over e.g. OpenRouter's 350-model sprawl. */
const NATIVE_PROVIDER_RANK = new Map(
  Object.keys(NATIVE_FLAGSHIP_CANDIDATES).map((id, index) => [id, index]),
);

/** The catalog fields the pre-runtime picker source reads per model — a
 *  structural subset of `@kortix/llm-catalog`'s `CatalogModel` (the wire
 *  shape), typed loose so both the shared type and test fixtures satisfy it. */
interface NativeCatalogModel {
  id: string;
  name: string;
  released?: string | null;
  status?: string;
  description?: string;
  family?: string;
  reasoning?: boolean;
  reasoning_options?: Array<{
    type: string;
    values?: Array<string | null>;
    min?: number;
    max?: number;
  }>;
  tool_call?: boolean;
  attachment?: boolean;
  open_weights?: boolean;
  last_updated?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  cost?: { input?: number; output?: number };
}

/**
 * Variant IDS for a model's thinking-mode row, mirroring how opencode itself
 * derives variants from the same models.dev `reasoning_options`
 * (opencode packages/opencode/src/provider/transform.ts `reasoningVariants`):
 * an `effort` knob contributes its published values verbatim (null → 'none'),
 * a `budget_tokens` knob contributes the synthesized high/max pair, anything
 * else contributes nothing. IDs only — the runtime owns the actual variant
 * SETTINGS and replaces this list wholesale the moment it loads, so a
 * pre-runtime pick lands on a runtime variant of the same name.
 */
function nativeVariantIds(model: NativeCatalogModel): string[] {
  const options = model.reasoning_options ?? [];
  const effort = options.find((option) => option.type === 'effort');
  if (effort) {
    return (effort.values ?? []).flatMap((value) => {
      if (value === null) return ['none'];
      return typeof value === 'string' ? [value] : [];
    });
  }
  if (options.some((option) => option.type === 'budget_tokens')) return ['high', 'max'];
  return [];
}

/**
 * OpenCode Zen — opencode's own provider. The runtime auto-connects it with
 * its FREE models even when no `OPENCODE_API_KEY` exists (opencode
 * packages/opencode/src/provider/provider.ts: the `opencode` provider is
 * always loaded, keyless it is trimmed to zero-cost models). The pre-runtime
 * source mirrors that so a booting sandbox never adds a provider the
 * pre-boot picker did not show.
 */
const ZEN_PROVIDER_ID = 'opencode';

function isFreeModel(model: NativeCatalogModel): boolean {
  return model.cost?.input === 0 && model.cost?.output === 0;
}

function providerRank(id: string): number {
  // Keyed table providers first (table order), then every other keyed
  // provider, Zen's keyless free tier last — "first connected provider" is
  // what the composer auto-picks, and a free preview model must never beat a
  // provider the user paid to connect.
  if (id === ZEN_PROVIDER_ID) return Number.MAX_SAFE_INTEGER;
  return NATIVE_PROVIDER_RANK.get(id) ?? Number.MAX_SAFE_INTEGER - 1;
}

export function nativeProviderListFromCatalog(
  catalog: {
    providers: Array<{
      id: string;
      name: string;
      models: Array<NativeCatalogModel>;
    }>;
  },
  secretNames: Set<string>,
): ProviderListResponse {
  const connectedIds = connectedGatewayProviderIdsFromSecretNames(secretNames);
  const defaults: Record<string, string> = {};
  const all = (catalog.providers ?? [])
    .map((provider) => {
      // opencode hides every model models.dev marks `status: "deprecated"`
      // (core/src/plugin/provider/opencode.ts: `enabled = status !==
      // "deprecated"`), so the runtime never lists them. Dev 2026-08-25:
      // 29 free Zen models in the box's models.json, 7 served.
      const live = (provider.models ?? []).filter((model) => model.status !== 'deprecated');
      return provider.id === ZEN_PROVIDER_ID && !connectedIds.has(ZEN_PROVIDER_ID)
        ? { ...provider, models: live.filter(isFreeModel), keyless: true }
        : { ...provider, models: live, keyless: false };
    })
    .filter(
      (provider) =>
        (provider.keyless || connectedIds.has(provider.id)) &&
        !NATIVE_EXCLUDED_PROVIDER_IDS.has(provider.id) &&
        (provider.models?.length ?? 0) > 0,
    )
    .sort((a, b) => providerRank(a.id) - providerRank(b.id))
    .map((provider) => {
      // Newest first: the picker's visual order and the "first model" fallback
      // both read insertion order.
      const models = [...provider.models].sort((a, b) =>
        (b.released ?? '').localeCompare(a.released ?? ''),
      );
      const ids = new Set(models.map((model) => model.id));
      const flagship =
        (NATIVE_FLAGSHIP_CANDIDATES[provider.id] ?? []).find((candidate) => ids.has(candidate)) ??
        models[0]?.id;
      if (flagship) defaults[provider.id] = flagship;
      return {
        id: provider.id,
        name: provider.name,
        source: provider.keyless ? 'api' : 'env',
        models: Object.fromEntries(
          models.map((model) => {
            const variantIds = nativeVariantIds(model);
            return [
              model.id,
              {
                id: model.id,
                name: model.name,
                ...(model.released ? { release_date: model.released } : {}),
                // Metadata parity with the runtime list: `family` +
                // `release_date` feed the picker's newest-per-family default
                // view (without them EVERY historical version rendered, ids
                // sharing a display name showed as duplicates); the
                // capability flags feed the badges; `variants` feeds the
                // thinking-mode row. All read by flattenModels' LooseModel
                // branch under the exact same keys the runtime serves.
                ...(model.family ? { family: model.family } : {}),
                ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
                ...(model.reasoning_options ? { reasoning_options: model.reasoning_options } : {}),
                ...(model.tool_call !== undefined ? { tool_call: model.tool_call } : {}),
                ...(model.attachment !== undefined ? { attachment: model.attachment } : {}),
                ...(model.modalities ? { modalities: model.modalities } : {}),
                ...(model.limit ? { limit: model.limit } : {}),
                ...(model.cost ? { cost: model.cost } : {}),
                ...(model.description ? { description: model.description } : {}),
                ...(model.open_weights !== undefined ? { open_weights: model.open_weights } : {}),
                ...(model.last_updated ? { last_updated: model.last_updated } : {}),
                ...(variantIds.length > 0
                  ? { variants: Object.fromEntries(variantIds.map((id) => [id, {}])) }
                  : {}),
              },
            ];
          }),
        ),
      };
    });
  return {
    all,
    connected: all.map((provider) => provider.id),
    default: defaults,
  } as unknown as ProviderListResponse;
}

/**
 * ONE native picker across sandbox states. Pre-boot the picker reads the
 * catalog synthesis (`nativeProviderListFromCatalog`); once the runtime
 * reports `/config/providers` it is the truth for what the box can actually
 * serve. Swapping sources on boot changed the picker under the user (provider
 * order, Zen appearing, the auto-picked default flipping). Merged instead:
 *
 * - shared provider ids take the RUNTIME object (real variant settings, the
 *   box's exact model set), in CATALOG order (flagship rank);
 * - runtime-only providers (Zen, auth.json logins) append after;
 * - the curated catalog default wins per provider while the runtime serves
 *   that model, else the runtime default — the auto-pick is stable across
 *   boot and never names a model the box cannot run.
 */
export function mergeNativeProviderLists(
  catalog: ProviderListResponse | undefined,
  runtime: ProviderListResponse | undefined,
): ProviderListResponse | undefined {
  if (!catalog) return runtime;
  if (!runtime) return catalog;
  const first = normalizeProviderList(catalog);
  const second = normalizeProviderList(runtime);
  type Provider = NonNullable<ProviderListResponse['all']>[number];
  const runtimeById = new Map<string, Provider>();
  for (const provider of Array.isArray(second.all) ? second.all : []) {
    runtimeById.set(provider.id, provider);
  }
  const all: Provider[] = [];
  const seen = new Set<string>();
  for (const provider of Array.isArray(first.all) ? first.all : []) {
    all.push(runtimeById.get(provider.id) ?? provider);
    seen.add(provider.id);
  }
  for (const provider of Array.isArray(second.all) ? second.all : []) {
    if (!seen.has(provider.id)) {
      all.push(provider);
      seen.add(provider.id);
    }
  }
  const connected: string[] = [];
  const connectedSeen = new Set<string>();
  for (const id of [
    ...(Array.isArray(first.connected) ? first.connected : []),
    ...(Array.isArray(second.connected) ? second.connected : []),
  ]) {
    if (!connectedSeen.has(id)) {
      connected.push(id);
      connectedSeen.add(id);
    }
  }
  const defaults: Record<string, string> = { ...(second.default ?? {}) };
  for (const [providerId, modelId] of Object.entries(first.default ?? {})) {
    const runtimeProvider = runtimeById.get(providerId);
    if (!runtimeProvider || (runtimeProvider.models && modelId in runtimeProvider.models)) {
      defaults[providerId] = modelId;
    }
  }
  return { ...second, all, connected, default: defaults };
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
