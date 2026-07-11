// Model plurality: when a BYOK key hits a limit (429/402/403), the gateway can
// fall over to an ordered CHAIN of managed models rather than a single one.
// These are pure helpers (config text → ordered id list); the request path
// (runFailover) already walks N candidates in order, so nothing downstream
// changes. `LLM_GATEWAY_BYOK_FALLBACK_MODEL` is read as a comma-separated chain
// — a single value behaves exactly as before.

/** Parse a comma-separated fallback chain, trimming + de-duping, order-preserving. */
export function parseFallbackChain(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** Keep the configured order, drop any model that isn't servable right now. */
export function resolveFallbackChain(
  chain: string[],
  isServable: (modelId: string) => boolean,
): string[] {
  return chain.filter(isServable);
}
