#!/usr/bin/env bun
/**
 * Regenerates packages/llm-catalog/src/catalog.generated.json from
 * models.dev's live api.json.
 *
 * *** WHY THIS SCRIPT EXISTS ***
 * models.dev's api.json carries far more per-model data than Kortix's
 * `CatalogModel` (packages/llm-catalog/src/index.ts) used to mirror — it used
 * to drop `reasoning_options`, `cost` (+ tiers/cache/context_over_200k),
 * `structured_output`, `knowledge`, `family`, and the full `modalities`
 * object, keeping only id/name/released/attachment/reasoning(bool)/tool_call/
 * temperature/limit{context,output}. Those dropped fields are exactly what
 * the per-model generation-controls panel (apps/web's gateway routing +
 * playground UI) needs to capability-gate a control ("does this model expose
 * a tunable reasoning effort, and what are the valid values?") and what the
 * gateway resolution layer needs to safely inject a configured default
 * (never send `temperature` to a `temperature:false` model, always clamp
 * `max_output_tokens` to `limit.output`). This script is the single place
 * that decides which models.dev fields survive into the baked snapshot —
 * `CatalogModel` is the single source of truth for the SHAPE; this script is
 * the single source of truth for the MIRROR.
 *
 * *** USAGE ***
 *   bun scripts/enrich-llm-catalog-capabilities.ts
 *   bun scripts/enrich-llm-catalog-capabilities.ts --source ./local-api.json
 *
 * Writes packages/llm-catalog/src/catalog.generated.json in place. Run this
 * whenever models.dev's catalog shape changes or the baked snapshot goes
 * stale — it is NOT wired into CI (models.dev moves faster than releases;
 * the API's runtime-catalog.ts refetches live every hour and is the actual
 * source of truth in production — see that file's normalizeCatalog, which
 * mirrors the identical field set as this script so the baked seed and the
 * live catalog never drift from each other in SHAPE, only in freshness).
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DEFAULT_SOURCE_URL = 'https://models.dev/api.json';
const OUTPUT_PATH = fileURLToPath(
  new URL('../../../packages/llm-catalog/src/catalog.generated.json', import.meta.url),
);

interface ModelsDevReasoningOption {
  type?: string;
  values?: string[];
}

interface ModelsDevCostTier {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tier?: { type?: string; size?: number };
}

interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  tiers?: ModelsDevCostTier[];
  context_over_200k?: ModelsDevCostTier;
}

interface ModelsDevModel {
  id?: string;
  name?: string;
  released?: string | null;
  release_date?: string | null;
  attachment?: boolean;
  reasoning?: boolean;
  reasoning_options?: ModelsDevReasoningOption[];
  tool_call?: boolean;
  structured_output?: boolean;
  temperature?: boolean;
  knowledge?: string;
  family?: string;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  cost?: ModelsDevCost;
}

interface ModelsDevProvider {
  id?: string;
  name?: string;
  env?: string[];
  doc?: string;
  api?: string | null;
  npm?: string | null;
  models?: Record<string, ModelsDevModel>;
}

type ModelsDevResponse = Record<string, ModelsDevProvider>;

function normalizeCostTier(tier: ModelsDevCostTier | undefined) {
  if (!tier) return undefined;
  return {
    ...(typeof tier.input === 'number' ? { input: tier.input } : {}),
    ...(typeof tier.output === 'number' ? { output: tier.output } : {}),
    ...(typeof tier.cache_read === 'number' ? { cache_read: tier.cache_read } : {}),
    ...(typeof tier.cache_write === 'number' ? { cache_write: tier.cache_write } : {}),
    ...(tier.tier?.type && typeof tier.tier.size === 'number'
      ? { tier: { type: tier.tier.type, size: tier.tier.size } }
      : {}),
  };
}

function normalizeCost(cost: ModelsDevCost | undefined) {
  if (!cost || typeof cost !== 'object') return undefined;
  const out: Record<string, unknown> = {};
  if (typeof cost.input === 'number') out.input = cost.input;
  if (typeof cost.output === 'number') out.output = cost.output;
  if (typeof cost.cache_read === 'number') out.cache_read = cost.cache_read;
  if (typeof cost.cache_write === 'number') out.cache_write = cost.cache_write;
  if (Array.isArray(cost.tiers) && cost.tiers.length) {
    const tiers = cost.tiers.map(normalizeCostTier).filter(Boolean);
    if (tiers.length) out.tiers = tiers;
  }
  const overflow = normalizeCostTier(cost.context_over_200k);
  if (overflow) out.context_over_200k = overflow;
  return Object.keys(out).length ? out : undefined;
}

function normalizeReasoningOptions(options: ModelsDevReasoningOption[] | undefined) {
  if (!Array.isArray(options) || options.length === 0) return undefined;
  const normalized = options
    .filter((option) => typeof option?.type === 'string' && Array.isArray(option.values))
    .map((option) => ({ type: option.type as string, values: option.values as string[] }));
  return normalized.length ? normalized : undefined;
}

function normalizeModel(modelKey: string, model: ModelsDevModel) {
  const reasoningOptions = normalizeReasoningOptions(model.reasoning_options);
  const cost = normalizeCost(model.cost);
  const limit =
    model.limit && typeof model.limit === 'object'
      ? {
          ...(typeof model.limit.context === 'number' ? { context: model.limit.context } : {}),
          ...(typeof model.limit.input === 'number' ? { input: model.limit.input } : {}),
          ...(typeof model.limit.output === 'number' ? { output: model.limit.output } : {}),
        }
      : undefined;
  const modalities =
    model.modalities && typeof model.modalities === 'object'
      ? {
          ...(Array.isArray(model.modalities.input) ? { input: model.modalities.input } : {}),
          ...(Array.isArray(model.modalities.output) ? { output: model.modalities.output } : {}),
        }
      : undefined;

  return {
    id: model.id || modelKey,
    name: model.name || model.id || modelKey,
    released: model.released ?? model.release_date ?? null,
    attachment: model.attachment,
    reasoning: model.reasoning,
    ...(reasoningOptions ? { reasoning_options: reasoningOptions } : {}),
    tool_call: model.tool_call,
    ...(typeof model.structured_output === 'boolean'
      ? { structured_output: model.structured_output }
      : {}),
    temperature: model.temperature,
    ...(typeof model.knowledge === 'string' ? { knowledge: model.knowledge } : {}),
    ...(typeof model.family === 'string' ? { family: model.family } : {}),
    ...(modalities ? { modalities } : {}),
    ...(limit ? { limit } : {}),
    ...(cost ? { cost } : {}),
  };
}

function normalizeCatalog(data: ModelsDevResponse, sourceUrl: string, fetchedAt: string) {
  const providers: unknown[] = [];
  let modelCount = 0;

  for (const [providerKey, provider] of Object.entries(data)) {
    if (!provider || typeof provider !== 'object') continue;
    const id = provider.id || providerKey;
    const models = Object.entries(provider.models ?? {})
      .map(([modelKey, model]) => normalizeModel(modelKey, model))
      // Newest-first — LlmProviderModel consumers (apps/web/src/lib/llm-providers.ts's
      // deriveHint) rely on this pre-sorted order.
      .sort((a, b) => (b.released ?? '').localeCompare(a.released ?? ''));
    modelCount += models.length;
    providers.push({
      id,
      name: provider.name || id,
      env: Array.isArray(provider.env) ? provider.env : undefined,
      doc: provider.doc,
      api: provider.api,
      npm: provider.npm,
      models,
    });
  }

  if (providers.length === 0 || modelCount === 0) {
    throw new Error('catalog source returned no providers or models');
  }

  return {
    source: sourceUrl,
    fetched_at: fetchedAt,
    provider_count: providers.length,
    model_count: modelCount,
    providers,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sourceFlagIndex = args.indexOf('--source');
  const sourceArg = sourceFlagIndex >= 0 ? args[sourceFlagIndex + 1] : undefined;

  let data: ModelsDevResponse;
  let sourceUrl: string;
  if (sourceArg) {
    const file = Bun.file(sourceArg);
    data = (await file.json()) as ModelsDevResponse;
    sourceUrl = DEFAULT_SOURCE_URL;
  } else {
    sourceUrl = DEFAULT_SOURCE_URL;
    const response = await fetch(sourceUrl, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`fetch ${sourceUrl} failed: HTTP ${response.status}`);
    data = (await response.json()) as ModelsDevResponse;
  }

  const catalog = normalizeCatalog(data, sourceUrl, new Date().toISOString());
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(
    `wrote ${OUTPUT_PATH} (${catalog.provider_count} providers, ${catalog.model_count} models)`,
  );
}

main().catch((err) => {
  console.error('[enrich-llm-catalog-capabilities] failed:', err);
  process.exit(1);
});
