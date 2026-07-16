import type { UpstreamDescriptor } from '../../domain';

export interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

function trimTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return url.slice(0, end);
}

const GENUINE_OPENAI_HOSTNAME = 'api.openai.com';

// True only for the real OpenAI API host, never for an OpenAI-COMPATIBLE
// upstream (OpenRouter, Groq, self-hosted vLLM/LiteLLM/Ollama, "custom", etc.)
// even though those share `kind: 'openai-compat'` and flow through this same
// transport. Checked on the resolved base URL rather than `descriptor.provider`
// so it stays correct even if a future catalog entry mislabels the provider id.
function isGenuineOpenAiUpstream(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === GENUINE_OPENAI_HOSTNAME;
  } catch {
    return false;
  }
}

// OpenAI's chat completions endpoint now rejects `max_tokens` for its current
// chat models (o-series, gpt-5.x, and newer gpt-4o snapshots all 400 with
// "Unsupported parameter: 'max_tokens' is not supported with this model. Use
// 'max_completion_tokens' instead.") — observed live against api.openai.com.
// `max_completion_tokens` is accepted for every model OpenAI still serves
// under chat/completions, so the translation is unconditional for genuine
// OpenAI traffic rather than a model-name allowlist that would need upkeep as
// OpenAI ships new model families. If the caller already sent
// `max_completion_tokens` (e.g. opencode/the SDK already speaks the new
// field), it passes through untouched and `max_tokens` is left alone too.
function translateMaxTokensForGenuineOpenAi(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!('max_tokens' in payload) || 'max_completion_tokens' in payload) return payload;
  const { max_tokens, ...rest } = payload;
  return { ...rest, max_completion_tokens: max_tokens };
}

export function buildUpstreamRequest(
  body: Record<string, unknown>,
  descriptor: UpstreamDescriptor,
): UpstreamRequest {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (!descriptor.omitAuthorization) headers.authorization = `Bearer ${descriptor.apiKey}`;
  if (descriptor.appName) headers['x-title'] = descriptor.appName;
  if (descriptor.appReferer) headers['http-referer'] = descriptor.appReferer;
  if (descriptor.headers) Object.assign(headers, descriptor.headers);

  let payload = body;
  if (descriptor.bodyExtras) payload = { ...payload, ...descriptor.bodyExtras };
  if (descriptor.resolvedModel) payload = { ...payload, model: descriptor.resolvedModel };
  if (isGenuineOpenAiUpstream(descriptor.baseUrl)) {
    payload = translateMaxTokensForGenuineOpenAi(payload);
  }

  return {
    url: `${trimTrailingSlash(descriptor.baseUrl)}/chat/completions`,
    headers,
    payload,
  };
}
