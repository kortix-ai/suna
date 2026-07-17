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

import {
  type ProviderAuthRequirement,
  CATALOG as catalog,
  primaryAuthEnvVars,
  providerAuthRequirement,
} from '@kortix/llm-catalog';

export interface LlmProviderModel {
  id: string;
  name: string;
  /**
   * release_date when known (YYYY-MM-DD). Used to drive newest-first ordering.
   * The catalog generator already pre-sorts each provider's models by this
   * field; the field is exposed so the UI can render a "released X ago" hint.
   */
  released: string | null;
}

export interface LlmProviderEntry {
  /** Stable id (matches provider-branding logo lookup). */
  id: string;
  /** Display name. */
  label: string;
  /**
   * Env vars the connect form collects and writes to project_secrets — the
   * PRIMARY auth method's fields (see `authRequirement`), not necessarily
   * the raw models.dev `env` list. Most providers have exactly one; some
   * (Azure, Bedrock) need multiple.
   */
  envVars: string[];
  /**
   * The full Kortix-owned auth requirement (possibly multiple independent
   * methods — see `@kortix/llm-catalog`'s `providerAuthRequirement`).
   * "Connected" detection must check this (any method fully satisfied), not
   * just `envVars` — a provider can have alias methods (e.g. Google) or,
   * in future, alternate methods (e.g. Bedrock SigV4) beyond the primary one
   * the connect form shows.
   */
  authRequirement: ProviderAuthRequirement;
  /** Where the user gets their credentials — opens in a new tab. */
  helpUrl: string | null;
  /** Short one-line tag shown in the catalog row. */
  hint: string;
  /** Catalog of models for this provider. */
  models: LlmProviderModel[];
  /** True for the curated popular set — pinned to the top of the catalog. */
  featured: boolean;
  /**
   * Platform-managed provider (the Kortix gateway). Injected into every sandbox
   * automatically — no API key, no connect/disconnect flow. Rendered as an
   * always-connected "Managed" row rather than a BYO credential entry.
   */
  managed?: boolean;
}

export interface RawProvider {
  id: string;
  name: string;
  env?: string[];
  doc?: string | null;
  models: LlmProviderModel[];
}

export interface RawCatalog {
  source: string;
  fetched_at: string;
  provider_count: number;
  model_count: number;
  providers: RawProvider[];
}

const BAKED_SEED = catalog as RawCatalog;

/**
 * Curated featured set — these surface first in the modal. Anything not in
 * this list is still browsable below, sorted A-Z.
 */
const FEATURED_IDS = new Set([
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'vercel',
  'github-copilot',
  'groq',
  'xai',
  'deepseek',
  'mistral',
  'cerebras',
  'togetherai',
  'fireworks-ai',
  'perplexity',
  'amazon-bedrock',
  'azure',
  'google-vertex',
  'huggingface',
  'cohere',
  'cohere-platform',
  'nvidia',
  'kortix',
]);

/**
 * The one-line tag shown in the catalog row — DERIVED from models.dev's own
 * model list (already newest-first per the catalog generator), never a
 * hand-maintained per-provider description. A hand-written map here rots
 * silently (it drifts from what a provider actually serves — the old
 * `amazon-bedrock: 'AWS Bedrock — Claude, Llama, Titan'` entry was already
 * wrong: Kortix's Bedrock transport only ever serves the Claude lineup) and
 * has to be hand-edited for every new provider models.dev adds. This reads
 * straight off `raw.models`, so it's automatically correct and automatically
 * covers new providers with zero code changes.
 */
function deriveHint(raw: RawProvider): string {
  if (raw.models.length === 0) return 'No models';
  const names = raw.models.slice(0, 2).map((m) => m.name);
  const remaining = raw.models.length - names.length;
  return remaining > 0 ? `${names.join(', ')} +${remaining} more` : names.join(', ');
}

function toEntry(raw: RawProvider): LlmProviderEntry {
  const featured = FEATURED_IDS.has(raw.id);
  const hint = deriveHint(raw);
  return {
    id: raw.id,
    label: raw.name,
    // NOT raw.env directly — models.dev's env list can include auth methods
    // Kortix's own transport doesn't implement (see providerAuthRequirement's
    // doc comment, e.g. Bedrock's SigV4 pair) or aliases for the same
    // credential (e.g. Google's 3 interchangeable key env vars). This is the
    // PRIMARY method's fields — what the connect form actually asks for.
    envVars: primaryAuthEnvVars(raw),
    authRequirement: providerAuthRequirement(raw),
    helpUrl: raw.doc ?? null,
    hint,
    models: raw.models,
    featured,
  };
}

/**
 * Featured first (in the FEATURED_IDS order), then everything else A-Z by id.
 * The featured order matters: we want Anthropic + OpenAI at the very top.
 */
function order(entries: LlmProviderEntry[]): LlmProviderEntry[] {
  const featuredOrder = Array.from(FEATURED_IDS);
  const featuredIndex = new Map(featuredOrder.map((id, index) => [id, index]));
  return [...entries].sort((a, b) => {
    if (a.featured && !b.featured) return -1;
    if (!a.featured && b.featured) return 1;
    if (a.featured && b.featured) {
      const ai = featuredIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bi = featuredIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    }
    return a.label.localeCompare(b.label);
  });
}

/** Pure: raw catalog (baked seed OR a live `/llm-catalog/providers` fetch) → the modal's provider list, sorted. */
export function buildLlmProviderCatalog(raw: RawCatalog): LlmProviderEntry[] {
  return order(raw.providers.map(toEntry));
}

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
