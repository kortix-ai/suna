import CODEX_SEED from './codex-models.seed.json';

export const CODEX_AUTH_SECRET_NAME = 'CODEX_AUTH_JSON';

// The model list the Codex CLI itself ships — the same `visibility: "list"`
// set `chatgpt.com/backend-api/codex/models` returns to a ChatGPT account
// (verified identical 2026-10-01, every plan). OpenAI edits it on launch day
// (#49318 added gpt-6.1-sol 2026-09-29; #47932 removed gpt-5.4, which the
// backend now refuses). Public, no auth, so the gateway refreshes it hourly
// beside models.dev (runtime-catalog.ts) instead of anyone keeping a list.
export const CODEX_MODELS_URL =
  'https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/models.json';

// Offline fallback only. Regenerate: `bun apps/api/src/llm-gateway/models/codex-models.ts`
// (the weekly catalog-refresh workflow does).
export const CODEX_SEED_MODEL_IDS: readonly string[] = CODEX_SEED;

const CODEX_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Picker-visible Codex slugs from a Codex `models.json` body, in Codex's own
 *  priority order. Throws on a shape it does not recognise so the caller keeps
 *  its last good list. */
export function parseCodexModelIds(body: unknown): string[] {
  const models = (body as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) throw new Error('codex models.json has no models array');
  const ids = models
    .filter(
      (m): m is { slug: string; priority?: number } =>
        m?.visibility === 'list' && typeof m.slug === 'string' && CODEX_SLUG.test(m.slug),
    )
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => m.slug);
  if (ids.length === 0) throw new Error('codex models.json lists no models');
  return ids;
}

if (import.meta.main) {
  const res = await fetch(CODEX_MODELS_URL);
  if (!res.ok) throw new Error(`${CODEX_MODELS_URL}: HTTP ${res.status}`);
  const ids = parseCodexModelIds(await res.json());
  await Bun.write(new URL('./codex-models.seed.json', import.meta.url), `${JSON.stringify(ids, null, 2)}\n`);
  console.log(`codex seed: ${ids.join(', ')}`);
}
