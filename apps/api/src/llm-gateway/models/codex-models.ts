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

// Offline fallback only. Regenerate: `bun apps/api/scripts/refresh-codex-seed.ts`
// (the weekly catalog-refresh workflow does).
export const CODEX_SEED_MODEL_IDS: readonly string[] = CODEX_SEED;

const CODEX_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Slugs models.json still marks `visibility: "list"` but the ChatGPT backend
// refuses, so a picker entry would 400 every turn. gpt-5.5: "The 'gpt-5.5'
// model is not supported when using Codex with a ChatGPT account"
// (observed 2026-10-14). Drop the entry here once OpenAI removes it upstream.
const REFUSED_MODEL_IDS: readonly string[] = ['gpt-5.5'];

/** A slug the ChatGPT backend refuses. A default or pin saved before it left
 *  the lineup must not reach the backend: the gateway calls it retired. */
export function isRefusedCodexModelId(slug: string): boolean {
  return REFUSED_MODEL_IDS.includes(slug);
}

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
    .filter((m) => !isRefusedCodexModelId(m.slug))
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((m) => m.slug);
  if (ids.length === 0) throw new Error('codex models.json lists no models');
  return ids;
}

