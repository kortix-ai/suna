import { providerKindForNpm, type ProviderKind } from '@kortix/llm-gateway';
import { runtimeModelCatalog } from './runtime-catalog';

const BASE_URL_FALLBACKS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  'x-ai': 'https://api.x.ai/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  perplexity: 'https://api.perplexity.ai',
  cerebras: 'https://api.cerebras.ai/v1',
  vercel: 'https://ai-gateway.vercel.sh/v1',
  v0: 'https://api.v0.dev/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  togetherai: 'https://api.together.xyz/v1',
};

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

export interface CatalogUpstream {
  baseUrl: string;
  envVar: string;
  kind: ProviderKind;
}

/** Resolve provider transport metadata from the API-owned runtime catalog. */
export function resolveCatalogUpstream(providerId: string): CatalogUpstream | null {
  const provider = runtimeModelCatalog
    .snapshot()
    .providers.find((candidate) => candidate.id === providerId);
  if (!provider) return null;

  const kind = providerKindForNpm(provider.npm);
  if (!kind) return null;

  const baseUrl =
    kind === 'anthropic' ? ANTHROPIC_BASE_URL : provider.api || BASE_URL_FALLBACKS[providerId];
  const envVar = provider.env?.[0];
  if (!baseUrl || !envVar) return null;

  return { baseUrl, envVar, kind };
}
