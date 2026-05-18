#!/usr/bin/env bun
/**
 * Fetches https://models.dev/api.json and writes a slimmed snapshot to
 *   apps/web/src/lib/llm-catalog.generated.json
 *
 * The slim shape is what the ProjectProviderModal actually consumes:
 *   - id, name, env[], doc
 *   - models[]: id + name only (we drop pricing/limits/capabilities for now)
 *
 * Re-run this script when you want to pick up new providers/models. There's
 * no automatic refresh — keeping it explicit so a stale catalog can never
 * surprise a user.
 *
 *   bun run apps/web/scripts/refresh-llm-catalog.ts
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_URL = 'https://models.dev/api.json';
const OUT_PATH = join(SCRIPT_DIR, '..', 'src', 'lib', 'llm-catalog.generated.json');

interface UpstreamModel {
  id?: string;
  name?: string;
  family?: string;
  release_date?: string | null;
  last_updated?: string | null;
  open_weights?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
}

interface UpstreamProvider {
  id?: string;
  name?: string;
  env?: string[] | null;
  doc?: string | null;
  api?: string | null;
  npm?: string | null;
  models?: Record<string, UpstreamModel>;
}

interface SlimModel {
  id: string;
  name: string;
  /**
   * release_date (YYYY-MM-DD) when available, else last_updated, else null.
   * Drives newest-first ordering inside each provider.
   */
  released: string | null;
}

interface SlimProvider {
  id: string;
  name: string;
  env: string[];
  doc: string | null;
  models: SlimModel[];
}

async function main() {
  console.log(`[catalog] fetching ${SOURCE_URL}…`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`models.dev returned ${res.status}: ${await res.text()}`);
  }
  const upstream = (await res.json()) as Record<string, UpstreamProvider>;

  const providers: SlimProvider[] = [];
  let totalModels = 0;

  for (const [key, raw] of Object.entries(upstream)) {
    const id = raw.id ?? key;
    const env = Array.isArray(raw.env) ? raw.env.filter((v): v is string => typeof v === 'string') : [];
    // Skip providers that have no env var — they can't be "connected" via secrets.
    if (env.length === 0) continue;

    const modelsObj = raw.models ?? {};
    const models: SlimModel[] = Object.entries(modelsObj).map(([modelId, model]) => ({
      id: model.id ?? modelId,
      name: model.name ?? model.id ?? modelId,
      released: model.release_date ?? model.last_updated ?? null,
    }));
    // Newest first by released; missing dates sink to the bottom and break
    // ties alphabetically by name so ordering stays deterministic.
    models.sort((a, b) => {
      if (a.released && b.released) {
        if (a.released < b.released) return 1;
        if (a.released > b.released) return -1;
      } else if (a.released) {
        return -1;
      } else if (b.released) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });

    providers.push({
      id,
      name: raw.name ?? id,
      env,
      doc: raw.doc ?? null,
      models,
    });
    totalModels += models.length;
  }

  // Stable provider ordering by id, A-Z. The frontend applies its own
  // featured-first ordering on top.
  providers.sort((a, b) => a.id.localeCompare(b.id));

  const snapshot = {
    source: SOURCE_URL,
    fetched_at: new Date().toISOString(),
    provider_count: providers.length,
    model_count: totalModels,
    providers,
  };

  writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');
  console.log(`[catalog] wrote ${providers.length} providers / ${totalModels} models to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
