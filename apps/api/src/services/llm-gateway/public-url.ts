/**
 * The public origin a customer should call the gateway at, derived from the
 * environment's `LLM_GATEWAY_BASE_URL`
 * (e.g. `https://gateway-dev.kortix.com/v1/llm` → `https://gateway-dev.kortix.com`).
 *
 * The frontend uses this to render an env-correct curl example on the API-keys
 * screen instead of hardcoding the prod host. Returns null when unset (local
 * dev) so callers can fall back gracefully.
 */
export function publicGatewayBaseUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}
