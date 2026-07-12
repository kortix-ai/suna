import type { LlmProviderEntry, LlmProviderModel } from '@/lib/llm-providers';

import {
  CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME,
  CODEX_AUTH_JSON_SECRET_NAME,
  CUSTOM_LLM_SECRET_NAMES,
  LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME,
} from './constants';
import type { ActiveTab } from './types';

export function providerCredentialSummary(provider: LlmProviderEntry): string {
  if (provider.id === 'claude-subscription') return 'Claude subscription';
  if (provider.id === 'codex') return 'ChatGPT subscription';
  if (provider.id === 'openai') return 'OpenAI API key';
  return provider.envVars.join(' · ');
}

type RuntimeProvidersSnapshot =
  | {
      connected?: string[];
      all?: Array<{ id: string; models?: Record<string, unknown> }>;
    }
  | undefined;

export function buildCodexProvider(ocProviders: RuntimeProvidersSnapshot): LlmProviderEntry {
  const connectedIds = new Set(ocProviders?.connected ?? []);
  const kortix = (ocProviders?.all ?? []).find((p) => p.id === 'kortix');
  const models: LlmProviderModel[] =
    kortix && connectedIds.has('kortix')
      ? Object.entries(kortix.models ?? {})
          .filter(([id]) => id.startsWith('codex/'))
          .map(([id, m]) => ({
            id: id.slice('codex/'.length),
            name: ((m as { name?: string }).name || id)
              .replace('(latest)', '')
              .trim()
              .replace(/\s*\(ChatGPT\)$/, ''),
            released:
              (m as { release_date?: string; released?: string }).release_date ??
              (m as { released?: string }).released ??
              null,
          }))
      : [];

  return {
    id: 'codex',
    label: 'ChatGPT',
    envVars: [CODEX_AUTH_JSON_SECRET_NAME, LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME],
    helpUrl: null,
    hint: 'ChatGPT Plus or Pro subscription',
    models,
    featured: true,
  };
}

export function buildClaudeSubscriptionProvider(secretNames: Set<string>): LlmProviderEntry | null {
  if (!secretNames.has(CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME)) return null;
  return {
    id: 'claude-subscription',
    label: 'Claude subscription',
    envVars: [CLAUDE_CODE_OAUTH_TOKEN_SECRET_NAME],
    helpUrl: 'https://docs.anthropic.com/en/docs/claude-code/iam',
    hint: 'Claude Code subscription auth',
    models: [],
    featured: true,
  };
}

export function buildCustomRestProvider(secretNames: Set<string>): LlmProviderEntry | null {
  if (!secretNames.has('CUSTOM_LLM_PROTOCOL') || !secretNames.has('CUSTOM_LLM_BASE_URL')) {
    return null;
  }
  return {
    id: 'custom-rest',
    label: 'Custom REST provider',
    envVars: [...CUSTOM_LLM_SECRET_NAMES],
    helpUrl: '',
    hint: 'Harness-compatible custom endpoint',
    models: [],
    featured: true,
  };
}

export function pickInitialTab(
  defaultTab: ActiveTab | undefined,
  hasConnections: boolean,
): ActiveTab {
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
