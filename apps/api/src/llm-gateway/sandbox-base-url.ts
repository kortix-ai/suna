/**
 * The single source of truth for "what URL does OpenCode's in-sandbox `kortix`
 * LLM provider hit" (KORTIX_LLM_BASE_URL). Takes the ORIGIN a sandbox should
 * use to reach kortix-api and applies the proxy-mode suffix rule.
 *
 * Deliberately a tiny, dependency-free module (only `../config`) rather than
 * living inline in session-sandbox.ts or sandbox-env-sync.ts: BOTH of those
 * need it —
 *   - session-sandbox.ts computes it once at sandbox boot (KORTIX_LLM_BASE_URL
 *     injected into the container's env), using `config.KORTIX_URL` as the origin.
 *   - workspaces/lib/sandbox-env-sync.ts recomputes it on every prompt / gateway-
 *     mode toggle (the hot env-push path posts it to the running daemon).
 * One implementation keeps boot and hot environment pushes synchronized.
 */
import { config } from '../config';

export function resolveLlmGatewayBaseUrl(origin: string): string {
  if (config.LLM_GATEWAY_BASE_URL) return config.LLM_GATEWAY_BASE_URL;
  const trimmedOrigin = origin.replace(/\/+$/, '');
  const llmProxyMode =
    config.LLM_GATEWAY_PROXY_PORT || config.LLM_GATEWAY_PROXY_TARGET;
  return llmProxyMode
    ? `${trimmedOrigin}/v1/llm-gateway/v1`
    : `${trimmedOrigin}/v1/llm`;
}
