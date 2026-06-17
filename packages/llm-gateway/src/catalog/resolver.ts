import { CATALOG } from '@kortix/shared/llm-catalog';
import { OPENAI_COMPATIBLE_NPM } from './compatibility';

const BASE_URL_FALLBACKS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  'x-ai': 'https://api.x.ai/v1',
  xai: 'https://api.x.ai/v1',
  mistral: 'https://api.mistral.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  perplexity: 'https://api.perplexity.ai',
  cerebras: 'https://api.cerebras.ai/v1',
};

export interface CatalogUpstream {
  baseUrl: string;
  envVar: string;
  kind: 'openai-compat';
}

const providerById = new Map(CATALOG.providers.map((provider) => [provider.id, provider]));

export function resolveCatalogUpstream(providerId: string): CatalogUpstream | null {
  const provider = providerById.get(providerId);
  if (!provider) return null;
  if (!provider.npm || !OPENAI_COMPATIBLE_NPM.has(provider.npm)) return null;

  const baseUrl = provider.api || BASE_URL_FALLBACKS[providerId];
  if (!baseUrl) return null;

  const envVar = provider.env?.[0];
  if (!envVar) return null;

  return { baseUrl, envVar, kind: 'openai-compat' };
}
