import type { LlmProviderEntry } from '@/lib/llm-providers';

import type { ActiveTab } from './types';

export function providerCredentialSummary(provider: LlmProviderEntry): string {
  if (provider.id === 'openai') return 'OpenAI API key or ChatGPT subscription';
  return provider.envVars.join(' · ');
}

export function pickInitialTab(defaultTab: ActiveTab | undefined, hasConnections: boolean): ActiveTab {
  if (defaultTab === 'catalog') return 'catalog';
  if (defaultTab === 'connected') return hasConnections ? 'connected' : 'catalog';
  if (defaultTab === 'models') return hasConnections ? 'models' : 'catalog';
  return hasConnections ? 'connected' : 'catalog';
}

export function helpHostnameFromUrl(helpUrl: string | null): string | null {
  if (!helpUrl) return null;
  try {
    return new URL(helpUrl).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Compact relative date — "3w", "5mo", "2y". Empty when unparseable. */
export function releasedAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const days = Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
  if (days < 7) return days === 0 ? 'today' : `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

export function buildCustomProviderSnippet(input: {
  providerId: string;
  name: string;
  baseURL: string;
  secretName: string | null;
  modelId: string;
  modelName: string;
}): string {
  const options: Record<string, string> = { baseURL: input.baseURL };
  if (input.secretName) options.apiKey = `{env:${input.secretName}}`;

  const snippet = {
    provider: {
      [input.providerId]: {
        npm: '@ai-sdk/openai-compatible',
        name: input.name,
        options,
        models: {
          [input.modelId]: {
            id: input.modelId,
            name: input.modelName,
            family: input.providerId,
          },
        },
      },
    },
  };

  return JSON.stringify(snippet, null, 2);
}

export function prettyFieldLabel(envVar: string): string {
  const trimmed = envVar
    .replace(/^[A-Z0-9]+_/, '')
    .replace(/_/g, ' ')
    .toLowerCase();
  const upper = trimmed.toUpperCase();
  if (upper === 'API KEY') return 'API key';
  if (upper === 'API URL') return 'API URL';
  if (upper === 'BASE URL') return 'Base URL';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function envVarPlaceholder(provider: LlmProviderEntry, envVar: string): string {
  if (provider.envVars.length === 1) {
    return `Paste your ${provider.label} API key…`;
  }
  return `Enter ${envVar}…`;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
