import type { ProviderKind, TranslationSidecarConfig, UpstreamDescriptor } from '../domain';
import type { UpstreamRequest } from './openai-compat';

// Provider kinds whose upstream already speaks the OpenAI chat/completions
// wire format verbatim (OpenAI itself, OpenRouter, Groq, x.ai, Mistral,
// DeepSeek, self-hosted/custom — everything sharing the openai-compat
// transport) are the ones a generic OpenAI-compatible sidecar client can
// stand in for. anthropic/bedrock build their own native request shapes
// (Messages API / Bedrock converse) via working dedicated transports, and
// codex runs its own credential/session flow — none of those route through
// the sidecar; delegating their quirks to LiteLLM isn't this change's job.
const SIDECAR_ELIGIBLE_KINDS: ReadonlySet<ProviderKind> = new Set<ProviderKind>([
  'openai-compat',
  'custom',
]);

// A descriptor with no apiKey and `omitAuthorization` (e.g. a free public
// upstream like OpenCode Zen) has nothing meaningful to hand the sidecar as
// `api_key` — LiteLLM's generic openai-compatible client requires a non-empty
// api_key even against endpoints that don't check it. Rather than guess a
// placeholder, these stay on the direct path; they're not the BYOK quirk
// surface this migration targets anyway.
export function isSidecarEligible(descriptor: Pick<UpstreamDescriptor, 'kind' | 'omitAuthorization'>): boolean {
  return SIDECAR_ELIGIBLE_KINDS.has(descriptor.kind) && !descriptor.omitAuthorization;
}

function trimTrailingSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end--;
  return url.slice(0, end);
}

// Rewrites an already-built direct-upstream request (openai-compat's
// buildUpstreamRequest output — resolvedModel/bodyExtras already merged) into
// a call against the stateless LiteLLM translation sidecar.
//
// The sidecar owns zero credentials of its own (no model_list creds, no
// virtual keys, no DB): every request must carry the real upstream's
// api_key/api_base per LiteLLM's documented clientside/dynamic-credential
// request shape (this requires the sidecar's config.yaml to set
// `general_settings.allow_client_side_credentials: true` and register a
// wildcard deployment — `model_name: "*"` / `litellm_params.model:
// "openai/*"` — with placeholder credentials that are never actually used,
// verified live against the real container: without allow_client_side_
// credentials the proxy 401s with "api_base is not allowed in request body").
//
// `model` is passed through UNCHANGED (exactly what buildUpstreamRequest
// already resolved — no "openai/" provider-prefix wrapping needed): verified
// live that with the wildcard deployment above, LiteLLM forwards the client's
// bare model string verbatim to the real upstream (api_base) and echoes the
// same bare string back in the response, so descriptor.resolvedModel keeps
// meaning exactly what it already means to the rest of this package (usage
// extraction, pricing lookups) with no extra rewriting.
export function buildSidecarRequest(
  direct: UpstreamRequest,
  descriptor: UpstreamDescriptor,
  sidecar: TranslationSidecarConfig,
): UpstreamRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sidecar.authToken) headers.authorization = `Bearer ${sidecar.authToken}`;

  const payload: Record<string, unknown> = {
    ...direct.payload,
    api_key: descriptor.apiKey,
    api_base: descriptor.baseUrl,
  };

  return {
    url: `${trimTrailingSlash(sidecar.url)}/v1/chat/completions`,
    headers,
    payload,
  };
}
