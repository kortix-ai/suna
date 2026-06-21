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

export function providerKindForNpm(npm: string | null | undefined): ProviderKind | null {
  if (!npm) return null;
  if (npm === ANTHROPIC_NPM) return 'anthropic';
  if (OPENAI_COMPATIBLE_NPM.has(npm)) return 'openai-compat';
  return null;
}
