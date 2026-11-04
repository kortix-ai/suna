/**
 * LLM-provider catalog for the per-project Provider Modal.
 *
 * *** DATA SOURCE — baked SEED, live OVERRIDE ***
 * The module initializes from a slim BAKED snapshot of models.dev's
 * api.json — `packages/llm-catalog/src/catalog.generated.json` — the same
 * seed `runtimeModelCatalog` (apps/api/src/llm-gateway/models/
 * runtime-catalog.ts) uses to boot before its own first live fetch. That's a
 * legitimate reason for the baked file to exist API-side: it's the
 * always-available fallback under `atomic last-known-good` semantics.
 *
 * The web app used to make this baked file its ONLY source — which meant it
 * went stale the moment models.dev changed anything models.dev-side (nothing
 * refreshed it; the one enrich script that touched it was never wired into
 * CI and has been deleted — packages/llm-catalog/src/catalog.generated.json
 * only still exists as the API-side seed described above).
 * `applyLiveLlmProviderCatalog` (called by `useLiveLlmProviderCatalog`, in
 * this section's `use-live-catalog.ts`) lets a caller push the SAME live,
 * hourly-refreshed catalog every other gateway endpoint already reads
 * (served via `GET /projects/:id/llm-catalog/providers`) over this baked
 * seed — reassigning the exported bindings below (ES module bindings are
 * live: existing `import { LLM_PROVIDERS }` call sites read the CURRENT
 * value on every access, no re-import needed). Until a live fetch lands (or
 * on a project whose caller doesn't fetch it, e.g. non-browser contexts),
 * the baked seed is what's served — never a hard failure.
 *
 * Provider display names, doc URLs, and hints are rendered VERBATIM from
 * models.dev — no hand-renaming or hand-written descriptions (see
 * `toEntry`/`deriveHint` below). models.dev already disambiguates
 * near-identical providers correctly (`moonshotai` "Moonshot AI" vs
 * `moonshotai-cn` "Moonshot AI (China)" vs `kimi-for-coding` "Kimi For
 * Coding") — a hand-maintained label/hint map that collapsed those back into
 * duplicates ("Moonshot" / "Moonshot") was exactly the kind of drift this
 * module no longer introduces.
 *
 * "Connecting" a provider writes its env vars to `project_secrets`. Sessions
 * pick those up as env vars at sandbox boot — so connecting Anthropic here is
 * exactly equivalent to setting ANTHROPIC_API_KEY on the Secrets page, just
 * with a friendlier flow.
 */

import { CATALOG as catalog } from '@kortix/llm-catalog';
import {
  type LlmProviderCatalogSource,
  type LlmProviderEntry,
  type LlmProviderModel,
  type LlmProviderSource,
  buildLlmProviderCatalog,
} from '@kortix/sdk';

// The row shape and the builder live in `@kortix/sdk` (core/models/provider-connections)
// so the TUI reads the same catalogue rows. This module keeps the live binding.
export { buildLlmProviderCatalog, type LlmProviderEntry, type LlmProviderModel };
export type RawProvider = LlmProviderSource;
export interface RawCatalog extends LlmProviderCatalogSource {
  source: string;
  fetched_at: string;
  provider_count: number;
  model_count: number;
}

const BAKED_SEED = catalog as RawCatalog;

// ES module bindings are LIVE — every `import { LLM_PROVIDERS } from
// '@/lib/llm-providers'` call site reads whatever these are reassigned to,
// at read time, no re-import needed. `applyLiveLlmProviderCatalog` below
// reassigns all four in place when a live fetch lands; until then, or for
// any caller that never fetches, these serve the baked seed.
export let LLM_PROVIDERS: LlmProviderEntry[] = buildLlmProviderCatalog(BAKED_SEED);

/** Lookup by id. */
export let LLM_PROVIDER_BY_ID = new Map<string, LlmProviderEntry>(
  LLM_PROVIDERS.map((entry) => [entry.id, entry]),
);

/** Lookup by env-var name — used to mark "connected" status from secret names. */
export let LLM_PROVIDER_BY_ENV_VAR = new Map<string, LlmProviderEntry>(
  LLM_PROVIDERS.flatMap((entry) => entry.envVars.map((envVar) => [envVar, entry] as const)),
);

/** Catalog metadata for diagnostic display ("catalog refreshed N hours ago"). */
export let LLM_CATALOG_META = {
  source: BAKED_SEED.source,
  fetchedAt: BAKED_SEED.fetched_at,
  providerCount: BAKED_SEED.provider_count,
  modelCount: BAKED_SEED.model_count,
  /** false until a live fetch has actually landed — lets the UI (or a test)
   *  distinguish "seed" from "confirmed live" if it ever wants to. */
  live: false,
};

type CatalogSubscriber = () => void;
const catalogSubscribers = new Set<CatalogSubscriber>();

/** `useSyncExternalStore`-compatible subscribe — see `useLlmProviderCatalogRevision` in `use-live-catalog.ts`. */
export function subscribeLlmProviderCatalog(onChange: CatalogSubscriber): () => void {
  catalogSubscribers.add(onChange);
  return () => catalogSubscribers.delete(onChange);
}

let catalogRevision = 0;
/** Snapshot for `useSyncExternalStore` — a primitive that changes identity iff the catalog changed. */
export function getLlmProviderCatalogRevision(): number {
  return catalogRevision;
}

/**
 * Push a live-fetched catalog (from `GET /projects/:id/llm-catalog/providers`)
 * over the baked seed. Reassigns `LLM_PROVIDERS`/`LLM_PROVIDER_BY_ID`/
 * `LLM_PROVIDER_BY_ENV_VAR`/`LLM_CATALOG_META` and notifies subscribers so a
 * component using `useLlmProviderCatalogRevision()` re-renders. Safe to call
 * repeatedly (e.g. on every 24h-staleTime refetch) — always a full rebuild
 * from the given raw catalog, never a partial merge.
 */
export function applyLiveLlmProviderCatalog(raw: RawCatalog): void {
  LLM_PROVIDERS = buildLlmProviderCatalog(raw);
  LLM_PROVIDER_BY_ID = new Map(LLM_PROVIDERS.map((entry) => [entry.id, entry]));
  LLM_PROVIDER_BY_ENV_VAR = new Map(
    LLM_PROVIDERS.flatMap((entry) => entry.envVars.map((envVar) => [envVar, entry] as const)),
  );
  LLM_CATALOG_META = {
    source: raw.source,
    fetchedAt: raw.fetched_at,
    providerCount: raw.provider_count,
    modelCount: raw.model_count,
    live: true,
  };
  catalogRevision += 1;
  for (const subscriber of catalogSubscribers) subscriber();
}
