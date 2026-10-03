import {
  DEFAULT_MANAGED_MODEL_IDS,
  MANAGED_FLAGSHIP_MODEL_ID,
  PLATFORM_DEFAULT_MODEL_ID,
  defaultEnabledModelIds,
} from '@kortix/llm-catalog/lite';

import type { FlatModel } from './model-flatten';
import type { ModelKey } from './model-key';
import { createModelLookup } from './model-lookup';

/**
 * Which models a composer's model picker shows out of the box. Framework-free:
 * `useModelStore` (web) wraps it with persisted pins, and any other host calls
 * it with its own.
 */

/**
 * Fallback allowlist for the rare non-gateway model that carries no release-date
 * metadata: only the flagship shows out of the box, everything else is opt-in via
 * "Manage models".
 */
const DEFAULT_VISIBLE_MODEL_IDS = new Set<string>([MANAGED_FLAGSHIP_MODEL_ID]);

/**
 * Provider id of the managed Kortix LLM gateway (see the sandbox's
 * `opencode.ts` provider config). It's a small, hand-picked catalog we control,
 * so every model in it is shown by default — `isVisible` short-circuits the
 * date-based "latest" heuristic for this provider. The newest-per-family
 * behaviour is kept for BYO providers, which is what it's for.
 */
const MANAGED_GATEWAY_PROVIDER_ID = 'kortix';

const SUBSCRIPTION_PROVIDER_ID = 'codex';

// The gateway bakes its ENTIRE routable catalog (every BYOK provider's models)
// into opencode so any model is callable the instant its key is connected — no
// session restart. The picker must therefore NOT show all of it by default: a
// `kortix` model is on out-of-the-box only when it's a platform-managed default
// or its underlying provider is connected (live, from project secrets). The
// rest stay one search away. Single source for the managed set lives in
// @kortix/llm-catalog (mirrors the gateway's managed-ids).
const MANAGED_MODEL_IDS = new Set<string>(DEFAULT_MANAGED_MODEL_IDS);

// `explicitProvider` (a model's `FlatModel.provider` / `ModelKey.provider`) is
// the robust path — the gateway now serves it directly, so grouping/gating
// never has to guess the real provider from string-splitting `modelID`.
// String-splitting on "/" remains only a fallback for a stale/older baked
// catalog that predates the field.
function subProviderOf(modelID: string, explicitProvider?: string): string {
  if (explicitProvider) return explicitProvider;
  const slash = modelID.indexOf('/');
  return slash === -1 ? modelID : modelID.slice(0, slash);
}

/**
 * True when at least one model in `allModels` is actually usable right now —
 * i.e. would work if sent, not merely present in the catalog. The gateway
 * bakes its ENTIRE routable catalog into every project regardless of plan or
 * connected keys (`providers.connected` always includes `kortix`), so raw
 * catalog presence (`providerListHasModels`, `models.length`) is never a
 * reliable "nothing is connected" signal — it's true even for a brand-new,
 * unpaid, no-BYOK account. This mirrors the entitlement half of `isVisible`
 * (managed models gated by `!freeTier`, BYOK-under-gateway models gated by
 * their sub-provider being connected) without its display-curation half
 * (the "latest per family" / flagship-only default view) — a model can be
 * fully usable while `isVisible` still hides it by default.
 */
export function hasUsableModel(
  allModels: FlatModel[],
  opts: { connectedProviderIds?: Set<string>; freeTier?: boolean },
): boolean {
  const connectedProviderIds = opts.connectedProviderIds;
  const freeTier = opts.freeTier ?? false;
  return allModels.some((m) => {
    if (m.providerID !== MANAGED_GATEWAY_PROVIDER_ID) {
      // Native/direct provider models: flattenModels only includes models
      // from CONNECTED providers, so presence here already means usable.
      return true;
    }
    if (MANAGED_MODEL_IDS.has(m.modelID)) {
      // The platform default is the ONE managed model every tier may use
      // (KRTX-1067) — the gateway serves it to free tier, so it is usable.
      return !freeTier || m.modelID === PLATFORM_DEFAULT_MODEL_ID;
    }
    const sub = subProviderOf(m.modelID, m.provider);
    return sub === SUBSCRIPTION_PROVIDER_ID
      ? (connectedProviderIds?.has(SUBSCRIPTION_PROVIDER_ID) ?? false)
      : (connectedProviderIds?.has(sub) ?? false);
  });
}

export function isDefaultVisible(model: ModelKey): boolean {
  return DEFAULT_VISIBLE_MODEL_IDS.has(model.modelID);
}

/**
 * "Latest" models, keyed `providerID:modelID` for the store's lookup maps.
 *
 * The RULE itself lives in `@kortix/llm-catalog` — the gateway enforces the
 * same default set server-side, and two copies of "newest per family within
 * the window" is exactly how the picker and "Manage models" drifted apart.
 * This is only the key-shape adapter.
 */
export function computeLatestSet(models: FlatModel[]): Set<string> {
  return defaultEnabledModelIds(
    models.map((m) => ({
      // Feed the store's own composite key through as the candidate id so the
      // result needs no lossy id → model lookup on the way back out.
      id: `${m.providerID}:${m.modelID}`,
      released: m.releaseDate,
      family: m.family,
      // `provider` is the real upstream under the gateway (every model is
      // served as `kortix`); for a native provider it IS the providerID.
      provider: m.provider ?? m.providerID,
    })),
  );
}

/** A user's explicit show/hide choice for one model ("Manage models"). */
export interface ModelVisibilityPin extends ModelKey {
  visibility: 'show' | 'hide';
}

/**
 * Build the default-visibility predicate for a model picker. Later pins for
 * the same model win. Rules, in order:
 *  • a `hide` pin hides;
 *  • gateway (`kortix`) models: a platform-managed model shows unless
 *    `freeTier` — the platform default always shows (the gateway serves it to
 *    every tier, KRTX-1067); any other shows only while its real provider is
 *    connected, then by `show` pin, newest-per-family, or the
 *    undated-flagship rule;
 *  • native models: `show` pin, newest per family within the window
 *    (`computeLatestSet`), else only the flagship when undated.
 *
 * `catalogModels` is the canonical universe the "latest" set and release dates
 * are read from — pass the full catalog from every surface so one model key
 * resolves the same everywhere.
 */
export function createModelVisibility(input: {
  catalogModels: FlatModel[];
  pins?: ReadonlyArray<ModelVisibilityPin>;
  connectedProviderIds?: Set<string>;
  freeTier?: boolean;
}): (model: ModelKey) => boolean {
  const { connectedProviderIds } = input;
  const freeTier = input.freeTier ?? false;
  const latestSet = computeLatestSet(input.catalogModels);
  const modelByKey = createModelLookup(input.catalogModels);
  const visibilityMap = new Map<string, 'show' | 'hide'>();
  for (const item of input.pins ?? []) {
    visibilityMap.set(`${item.providerID}:${item.modelID}`, item.visibility);
  }

  return (model: ModelKey): boolean => {
    const key = `${model.providerID}:${model.modelID}`;
    const state = visibilityMap.get(key);
    if (state === 'hide') return false;
    // Gateway (kortix) models. The catalog is namespaced `<provider>/<model>`,
    // and connection is AUTHORITATIVE — it overrides any stale `show` pin, so a
    // disconnected provider's models disappear (even ones you'd used) and a
    // freshly connected provider's models appear, with no per-model pinning.
    // Visible only when: Codex subscription (`codex/<id>`, present once
    // connected), a platform-managed default, or the BYOK provider is
    // connected. Everything else is search-only so the catalog can't flood.
    if (model.providerID === MANAGED_GATEWAY_PROVIDER_ID) {
      const sub = subProviderOf(model.modelID, model.provider);
      // Codex (ChatGPT subscription) is now baked unconditionally like BYOK, so
      // gate its display on the subscription being connected.
      const connected =
        sub === SUBSCRIPTION_PROVIDER_ID
          ? (connectedProviderIds?.has(SUBSCRIPTION_PROVIDER_ID) ?? false)
          : (connectedProviderIds?.has(sub) ?? false);
      if (MANAGED_MODEL_IDS.has(model.modelID)) {
        // The platform default is the ONE managed model every tier may use
        // (KRTX-1067); every other managed model stays paid.
        return !freeTier || model.modelID === PLATFORM_DEFAULT_MODEL_ID;
      }
      if (!connected) return false;
      if (state === 'show') return true;
      if (latestSet.has(key)) return true;
      const m = modelByKey.get(key);
      if (!m?.releaseDate) return isDefaultVisible(model);
      try {
        const d = new Date(m.releaseDate);
        if (Number.isNaN(d.getTime())) return isDefaultVisible(model);
      } catch {
        return isDefaultVisible(model);
      }
      return false;
    }
    if (state === 'show') return true;
    if (latestSet.has(key)) return true;
    const m = modelByKey.get(key);
    // No (or invalid) release metadata — the managed Kortix gateway case.
    // Default to showing only the flagship; every other model is opt-in via
    // "Manage models". Providers that DO carry release dates keep the
    // newest-per-family "latest" behaviour handled above.
    if (!m?.releaseDate) return isDefaultVisible(model);
    try {
      const d = new Date(m.releaseDate);
      if (Number.isNaN(d.getTime())) return isDefaultVisible(model);
    } catch {
      return isDefaultVisible(model);
    }
    return false;
  };
}

/**
 * Which models the picker shows when the search box is EMPTY — the default
 * view.
 *
 * Gateway (`kortix`-provider) models are already server-curated: the
 * `/model-picker` catalog stamps `enabled` from the shared newest-per-family
 * rule, and the `enabled !== false` filter upstream of this function applies
 * it. NATIVE provider models had no equivalent — the runtime list (opencode's
 * own catalog) and the pre-runtime list (models.dev via the API) are both
 * unstamped, so a connected OpenRouter key rendered ALL ~355 models as a
 * wall. This applies the client twin of the same rule: `isStoreVisible`
 * (`createModelVisibility` — newest per family within the window, flagships,
 * plus the user's explicit show/hide pins).
 *
 * Two deliberate carve-outs:
 *  • a SEARCH query reveals everything — typing is intent, and hiding search
 *    hits behind a second toggle is how models become unfindable;
 *  • the currently-selected model always renders, or the check mark would
 *    point at a row that does not exist.
 */
export function modelInDefaultView(
  model: FlatModel,
  input: {
    search: string;
    isStoreVisible: (model: { providerID: string; modelID: string }) => boolean;
    selected: { providerID: string; modelID: string } | null;
  },
): boolean {
  if (input.search.trim().length > 0) return true;
  if (model.providerID === 'kortix') return true;
  if (
    input.selected &&
    input.selected.providerID === model.providerID &&
    input.selected.modelID === model.modelID
  ) {
    return true;
  }
  return input.isStoreVisible({ providerID: model.providerID, modelID: model.modelID });
}
