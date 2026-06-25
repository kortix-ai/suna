#!/usr/bin/env bun
/**
 * Refresh per-model capability flags in the committed LLM catalog snapshot
 * (`packages/shared/src/llm-catalog/catalog.generated.json`) from models.dev.
 *
 * The snapshot is intentionally slim (id/name/released per model + provider
 * routing fields). models.dev publishes per-model capabilities — attachment
 * (vision/files), reasoning, tool_call, temperature — which this enriches IN
 * PLACE, keyed by provider+model id. It does NOT change the provider set or any
 * routing field (env/api/npm/doc), so resolveCatalogUpstream is unaffected.
 *
 *   bun apps/web/scripts/refresh-llm-catalog.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type MdModel = {
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  temperature?: boolean;
  release_date?: string | null;
  limit?: { context?: number; output?: number };
};
type MdProvider = { models?: Record<string, MdModel> };

const CATALOG_PATH = join(
  import.meta.dir,
  '../../../packages/shared/src/llm-catalog/catalog.generated.json',
);

async function main() {
  const res = await fetch('https://models.dev/api.json');
  if (!res.ok) throw new Error(`models.dev fetch failed: HTTP ${res.status}`);
  const md = (await res.json()) as Record<string, MdProvider>;

  const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8'));
  let enriched = 0;
  let missing = 0;

  for (const provider of catalog.providers) {
    const mdModels = md[provider.id]?.models;
    for (const model of provider.models) {
      const m = mdModels?.[model.id];
      if (!m) {
        missing++;
        continue;
      }
      model.attachment = !!m.attachment;
      model.reasoning = !!m.reasoning;
      model.tool_call = !!m.tool_call;
      model.temperature = !!m.temperature;
      if (m.limit && (m.limit.context || m.limit.output)) {
        model.limit = { context: m.limit.context, output: m.limit.output };
      }
      enriched++;
    }
  }

  catalog.fetched_at = new Date().toISOString();
  writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`✓ enriched ${enriched} models with capability flags (${missing} not on models.dev)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
