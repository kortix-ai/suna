import type { ProviderKind } from '../domain';

const ANTHROPIC_NPM = '@ai-sdk/anthropic';
const AMAZON_BEDROCK_NPM = '@ai-sdk/amazon-bedrock';

// Google's native Gemini wire protocol and Vertex service-account OAuth are
// not implemented here. The API maps direct Gemini BYOK to Google's separate
// OpenAI-compatible endpoint in provider-registry.ts. Keep the native npm
// package unroutable here so another caller cannot silently send it to an
// OpenAI-compatible endpoint without that explicit registry mapping.
const NO_TRANSPORT_YET_NPM = new Set([
  '@ai-sdk/google',
  '@ai-sdk/google-vertex',
  '@ai-sdk/google-vertex/anthropic',
]);

// Maps a models.dev provider's npm package to the transport kind that speaks
// its wire format, so BYOK providers (project connects its own key) resolve to
// a working upstream descriptor.
//
// DEFAULT = openai-compat. Audited every npm value across models.dev's full
// provider list (2026-07-17): of ~167 providers, 132 are literally
// `@ai-sdk/openai-compatible` and 4 are `@ai-sdk/openai`; nearly every
// remaining one (xai/groq/mistral/perplexity/cerebras/togetherai/deepinfra/
// vercel/azure/openrouter and the long tail of published
// `*-ai-sdk-provider` packages) also speaks the OpenAI chat-completions wire
// format under the hood. Defaulting to openai-compat — rather than
// maintaining a growing per-package allowlist — means a brand-new provider
// models.dev adds tomorrow is routable with ZERO code changes here, as long
// as it isn't one of the few genuine exceptions called out explicitly below.
// Anything that ISN'T actually OpenAI-wire-compatible must be added to
// `NO_TRANSPORT_YET_NPM` (or given its own `ProviderKind`) — silently
// defaulting a truly incompatible provider here would produce confidently
// wrong requests, not a clear error, so keep that exception list honest.
//
// Explicit exceptions:
//  - Anthropic (`@ai-sdk/anthropic`) → its own Messages wire format.
//  - Bedrock (`@ai-sdk/amazon-bedrock`) → the `bedrock` transport, which
//    authenticates with a long-lived Bedrock API key (bearer token,
//    AWS_BEARER_TOKEN_BEDROCK) against the regional runtime endpoint. This
//    makes Bedrock a STANDALONE BYOK provider — like OpenRouter/OpenAI —
//    that a project connects its OWN key to, fully independent of the
//    CLOUD-ONLY Kortix-managed-credits path (KORTIX_MANAGED_PROVIDER_ENABLED).
//    See resolveCatalogUpstream (apps/api/.../provider-registry.ts) for the
//    region/bearer-token wiring, and memory: managed-provider-vs-standalone-byok.
//    (The bedrock transport builds an Anthropic Messages payload, so the
//    served Bedrock models are the Claude-on-Bedrock lineup.)
//  - Google's native package / Google Vertex → `NO_TRANSPORT_YET_NPM`.
export function providerKindForNpm(npm: string | null | undefined): ProviderKind | null {
  if (!npm) return null;
  if (npm === ANTHROPIC_NPM) return 'anthropic';
  if (npm === AMAZON_BEDROCK_NPM) return 'bedrock';
  if (NO_TRANSPORT_YET_NPM.has(npm)) return null;
  return 'openai-compat';
}
