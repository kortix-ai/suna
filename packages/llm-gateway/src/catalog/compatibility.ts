import type { ProviderKind } from '../domain';

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

// Maps a models.dev provider's npm package to the transport kind that speaks
// its wire format, so BYOK providers (project connects its own key) resolve to
// a working upstream descriptor. Anything unmapped returns null → no BYOK
// resolution path for that provider.
//
// Bedrock (`@ai-sdk/amazon-bedrock`) → the `bedrock` transport, which authenticates
// with a long-lived Bedrock API key (bearer token, AWS_BEARER_TOKEN_BEDROCK) against
// the regional runtime endpoint. This makes Bedrock a STANDALONE BYOK provider —
// like OpenRouter/OpenAI — that a project connects its OWN key to, fully independent
// of the CLOUD-ONLY Kortix-managed-credits path (KORTIX_MANAGED_PROVIDER_ENABLED). The
// managed provider exists only so cloud users can spend Kortix credits seamlessly; it
// is NOT how Bedrock is made available. See resolveCatalogUpstream (apps/api/.../
// provider-registry.ts) for the region/bearer-token wiring, and memory:
// managed-provider-vs-standalone-byok. (The bedrock transport builds an Anthropic
// Messages payload, so the served Bedrock models are the Claude-on-Bedrock lineup.)
export function providerKindForNpm(npm: string | null | undefined): ProviderKind | null {
  if (!npm) return null;
  if (npm === ANTHROPIC_NPM) return 'anthropic';
  if (npm === AMAZON_BEDROCK_NPM) return 'bedrock';
  if (OPENAI_COMPATIBLE_NPM.has(npm)) return 'openai-compat';
  return null;
}
