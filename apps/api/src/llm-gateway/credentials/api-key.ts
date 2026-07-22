/**
 * Generic API-key liveness — docs/specs/2026-07-22-unified-auth-gateway.md
 * §5.3. Today every plain API-key kind (`anthropic_api_key`, `openai_api_key`,
 * every BYOK catalog provider) is presence-only
 * (`resolution/harness-models.ts`'s `isCredentialConfigured`, unchanged by
 * this module). This adds the ONE thing that's missing: "is the key actually
 * accepted by the upstream," via a cheap, side-effect-free-as-possible probe
 * request — never a real completion/spend.
 *
 * ── Scope, explicitly capped per the spec ──
 * Only the two Phase-1 launch providers with a real probe wired here
 * (Anthropic, OpenAI) — every other provider id has no entry in `PROBES`
 * and correctly returns `'unverified'`, which is the honest default for "a
 * key exists and nobody has spent a request confirming it," not a bug.
 * GitHub Copilot/xAI are Phase 2 (no `HarnessAuthKind` yet, per
 * `auth/registry.ts`'s doc comment) — not addressed here at all.
 */

export type ApiKeyLivenessStatus = 'healthy' | 'invalid' | 'unverified';

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

interface LivenessProbe {
  (apiKey: string, fetchImpl: FetchImpl): Promise<ApiKeyLivenessStatus>;
}

async function probeStatusOnly(
  fetchImpl: FetchImpl,
  url: string,
  headers: Record<string, string>,
): Promise<ApiKeyLivenessStatus> {
  try {
    const response = await fetchImpl(url, { method: 'GET', headers });
    if (response.ok) return 'healthy';
    if (response.status === 401 || response.status === 403) return 'invalid';
    // Rate-limited (429), server error (5xx), or anything else ambiguous —
    // never mislabel a transient/opaque failure as a broken key.
    return 'unverified';
  } catch {
    return 'unverified';
  }
}

// GET /v1/models is the standard cheap "does this key work" probe for both
// providers below — a list call, never a completion, no meaningful spend.
const probeAnthropicApiKey: LivenessProbe = (apiKey, fetchImpl) =>
  probeStatusOnly(fetchImpl, 'https://api.anthropic.com/v1/models?limit=1', {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  });

const probeOpenAiApiKey: LivenessProbe = (apiKey, fetchImpl) =>
  probeStatusOnly(fetchImpl, 'https://api.openai.com/v1/models', {
    Authorization: `Bearer ${apiKey}`,
  });

/**
 * Registered by `@kortix/llm-catalog` provider id (the same id
 * `auth/registry.ts`'s api-key entries and `deriveCatalogByokEntries()` use)
 * — NOT by `HarnessAuthKind`, since several catalog providers can in
 * principle share one kind's shape. Extend this table (not a second
 * per-provider table elsewhere) when a new provider's probe is written —
 * per the spec's "Extensible registry for future providers" item.
 */
const PROBES: Record<string, LivenessProbe> = {
  anthropic: probeAnthropicApiKey,
  openai: probeOpenAiApiKey,
};

// In-process, per-(providerId, key) rate limit so a UI poll loop can't
// hammer the upstream on every render — explicitly NOT a `project_secrets`
// column/cache per spec §11#5's recommendation against pre-emptive DB
// caching; this is ephemeral, per-replica, and cheap to lose on a restart.
const RATE_LIMIT_MS = 30_000;
const lastProbeAt = new Map<string, { at: number; result: ApiKeyLivenessStatus }>();

function rateLimitKey(providerId: string, apiKey: string): string {
  // Never key the cache on the raw secret in a way that could be logged
  // accidentally (e.g. an uncaught exception dumping a Map) — a short,
  // non-reversible fingerprint is enough to disambiguate keys per provider.
  let hash = 0;
  for (let i = 0; i < apiKey.length; i++) {
    hash = (hash * 31 + apiKey.charCodeAt(i)) | 0;
  }
  return `${providerId}:${hash}`;
}

/**
 * Checks whether `apiKey` is currently accepted by `providerId`'s upstream.
 * `'unverified'` for any provider without a registered probe (correct, not
 * a gap — see module doc). Rate-limited server-side per `RATE_LIMIT_MS`;
 * never logs the key.
 */
export async function checkApiKeyLiveness(
  providerId: string,
  apiKey: string,
  fetchImpl: FetchImpl = (input, init) => fetch(input, init),
): Promise<ApiKeyLivenessStatus> {
  const trimmed = apiKey.trim();
  if (!trimmed) return 'invalid';

  const probe = PROBES[providerId];
  if (!probe) return 'unverified';

  const cacheKey = rateLimitKey(providerId, trimmed);
  const cached = lastProbeAt.get(cacheKey);
  if (cached && Date.now() - cached.at < RATE_LIMIT_MS) {
    return cached.result;
  }

  const result = await probe(trimmed, fetchImpl);
  lastProbeAt.set(cacheKey, { at: Date.now(), result });
  return result;
}

/** True iff a live probe exists for `providerId` — lets a caller decide
 *  whether to even attempt a check vs immediately reporting `'unverified'`. */
export function hasLivenessProbe(providerId: string): boolean {
  return providerId in PROBES;
}
