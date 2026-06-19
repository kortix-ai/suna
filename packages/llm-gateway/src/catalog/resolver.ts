import { CATALOG } from '@kortix/shared/llm-catalog';
import { providerKindForNpm } from './compatibility';
import type { ProviderKind } from '../domain';

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

const ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

export interface CatalogUpstream {
  baseUrl: string;
  envVar: string;
  kind: ProviderKind;
}

const providerById = new Map(CATALOG.providers.map((provider) => [provider.id, provider]));

export function resolveCatalogUpstream(providerId: string): CatalogUpstream | null {
  const provider = providerById.get(providerId);
  if (!provider) return null;

  const kind = providerKindForNpm(provider.npm);
  if (!kind) return null;

  const baseUrl =
    kind === 'anthropic' ? ANTHROPIC_BASE_URL : provider.api || BASE_URL_FALLBACKS[providerId];
  if (!baseUrl) return null;

  const envVar = provider.env?.[0];
  if (!envVar) return null;

  return { baseUrl, envVar, kind };
}
