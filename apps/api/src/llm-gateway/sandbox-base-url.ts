/**
 * The single source of truth for "what URL does OpenCode's in-sandbox `kortix`
 * LLM provider hit" (KORTIX_LLM_BASE_URL). Takes the ORIGIN a sandbox should
 * use to reach kortix-api and applies the proxy-mode suffix rule.
 *
 * Deliberately a tiny, dependency-free module (only `../config`) rather than
 * living inline in session-sandbox.ts or sandbox-env-sync.ts: BOTH of those
 * need it —
 *   - session-sandbox.ts computes it once at sandbox boot (KORTIX_LLM_BASE_URL
 *     injected into the container's env), using
 *     `provider.sandboxFacingApiOrigin() ?? config.KORTIX_URL` as the origin.
 *   - projects/lib/sandbox-env-sync.ts recomputes it on every prompt / gateway-
 *     mode toggle (the hot env-push path posts it to the running daemon).
 * A same-machine provider's fix at boot time is silently undone by the next
 * prompt's hot push if that second call site keeps its own copy of this
 * formula hardcoded to the generic public origin — exactly what happened with
 * local-docker (KORTIX_LLM_BASE_URL fell back to the unreachable
 * `${KORTIX_URL}/v1/llm` from inside the sandbox's private Docker network).
 * One implementation, called with the right origin at every call site, closes
 * that gap for good.
 */
import { config } from '../config';

export function resolveLlmGatewayBaseUrl(origin: string): string {
  if (config.LLM_GATEWAY_BASE_URL) return config.LLM_GATEWAY_BASE_URL;
  const trimmedOrigin = origin.replace(/\/+$/, '');
  const llmProxyMode = config.LLM_GATEWAY_PROXY_PORT || config.LLM_GATEWAY_PROXY_TARGET;
  return llmProxyMode ? `${trimmedOrigin}/v1/llm-gateway/v1/llm` : `${trimmedOrigin}/v1/llm`;
}
