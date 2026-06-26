import { config } from '../config';

/**
 * Resolve the gateway base URL a sandbox's `kortix` provider points at.
 *
 * The LLM gateway is the ONLY LLM path. An explicit LLM_GATEWAY_BASE_URL wins;
 * otherwise we derive it from KORTIX_URL. Proxy mode (LLM_GATEWAY_PROXY_PORT /
 * LLM_GATEWAY_PROXY_TARGET) routes through the `/v1/llm-gateway/v1/llm` prefix;
 * the default direct path is `/v1/llm`.
 */
export function resolveLlmGatewayBaseUrl(): string {
  const kortixOrigin = config.KORTIX_URL.replace(/\/+$/, '');
  const llmProxyMode = config.LLM_GATEWAY_PROXY_PORT || config.LLM_GATEWAY_PROXY_TARGET;
  return (
    config.LLM_GATEWAY_BASE_URL ||
    (llmProxyMode ? `${kortixOrigin}/v1/llm-gateway/v1/llm` : `${kortixOrigin}/v1/llm`)
  );
}

/**
 * Build the KORTIX_LLM_* env injected into a sandbox so opencode's `kortix`
 * provider mounts and authenticates the gateway with the per-session executor
 * PAT. Returns an empty object when there is no executor token (nothing to
 * inject). YOLO is gone — the vestigial KORTIX_YOLO_* vars are intentionally
 * NOT emitted here.
 */
export function buildGatewayLlmEnv(
  executorToken: string | null,
  baseUrl: string,
): Record<string, string> {
  return executorToken
    ? { KORTIX_LLM_API_KEY: executorToken, KORTIX_LLM_BASE_URL: baseUrl }
    : {};
}
