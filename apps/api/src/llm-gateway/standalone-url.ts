import { config } from '../config';

/** `<gateway>/v1/chat/completions` of the standalone LLM gateway, or null when unconfigured. */
export function standaloneGatewayUrl(): string | null {
  const target =
    config.LLM_GATEWAY_PROXY_TARGET ||
    (config.LLM_GATEWAY_PROXY_PORT
      ? `http://127.0.0.1:${config.LLM_GATEWAY_PROXY_PORT}`
      : '');
  if (!target) return null;
  try {
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${target.replace(/\/+$/, '')}/v1/chat/completions`;
  } catch {
    return null;
  }
}
