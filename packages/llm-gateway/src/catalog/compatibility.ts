import type { ProviderKind } from '../domain';

// Retained for external callers that referenced the old explicit allowlist —
// `providerKindForNpm` below no longer requires membership in this set to
// dispatch a package to the openai-compat transport (openai-compat is the
// DEFAULT now — see its doc comment), but these are confirmed, common
// examples worth naming.
export const OPENAI_COMPATIBLE_NPM = new Set([
  '@ai-sdk/openai-compatible',
  '@ai-sdk/openai',
  '@ai-sdk/azure',
  '@ai-sdk/groq',
  '@ai-sdk/mistral',
  '@ai-sdk/xai',
  '@ai-sdk/cerebras',
  '@ai-sdk/togetherai',
  '@ai-sdk/deepinfra',
  '@ai-sdk/perplexity',
  '@ai-sdk/vercel',
  '@ai-sdk/gateway',
  '@openrouter/ai-sdk-provider',
]);

const ANTHROPIC_NPM = '@ai-sdk/anthropic';
const AMAZON_BEDROCK_NPM = '@ai-sdk/amazon-bedrock';

// Providers with a genuinely DIFFERENT wire protocol from OpenAI's — Google's
// Gemini API (direct or via Vertex) is not OpenAI-compatible, and Kortix has
// no `google` transport yet (would also need Vertex's service-account OAuth,
// a different auth shape than the simple bearer-key BYOK model everything
// else here uses — a separate, unstarted piece of work). Explicitly
// unroutable rather than silently mis-dispatched to openai-compat, which
// would produce confidently-wrong requests instead of a clear
// "can't connect this provider yet."
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
//  - Google / Google Vertex → `NO_TRANSPORT_YET_NPM` (see its doc comment).
export function providerKindForNpm(npm: string | null | undefined): ProviderKind | null {
  if (!npm) return null;
  if (npm === ANTHROPIC_NPM) return 'anthropic';
  if (npm === AMAZON_BEDROCK_NPM) return 'bedrock';
  if (NO_TRANSPORT_YET_NPM.has(npm)) return null;
  return 'openai-compat';
}
