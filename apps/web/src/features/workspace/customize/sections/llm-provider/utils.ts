import type { LlmProviderEntry, LlmProviderModel } from '@/lib/llm-providers';

import { CODEX_AUTH_JSON_SECRET_NAME, LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME } from './constants';
import type { ActiveTab } from './types';

export function providerCredentialSummary(provider: LlmProviderEntry): string {
  if (provider.id === 'codex') return 'ChatGPT subscription';
  if (provider.id === 'openai') return 'OpenAI API key';
  return provider.envVars.join(' · ');
}

type OpenCodeProvidersSnapshot =
  | {
      connected?: string[];
      all?: Array<{ id: string; models?: Record<string, unknown> }>;
    }
  | undefined;

export function buildCodexProvider(ocProviders: OpenCodeProvidersSnapshot): LlmProviderEntry {
  const connectedIds = new Set(ocProviders?.connected ?? []);
  const kortix = (ocProviders?.all ?? []).find((p) => p.id === 'kortix');
  const models: LlmProviderModel[] =
    kortix && connectedIds.has('kortix')
      ? Object.entries(kortix.models ?? {})
          .filter(([id]) => id.startsWith('codex/'))
          .map(([id, m]) => {
            const raw = m as {
              name?: string;
              release_date?: string;
              released?: string;
              reasoning?: boolean;
              tool_call?: boolean;
              limit?: { context?: number; output?: number };
            };
            return {
              id: id.slice('codex/'.length),
              name: (raw.name || id)
                .replace('(latest)', '')
                .trim()
                .replace(/\s*\(ChatGPT\)$/, ''),
              released: raw.release_date ?? raw.released ?? null,
              reasoning: raw.reasoning,
              tool_call: raw.tool_call,
              limit: raw.limit,
            };
          })
      : [];

  return {
    id: 'codex',
    label: 'ChatGPT',
    envVars: [CODEX_AUTH_JSON_SECRET_NAME, LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME],
    // EITHER secret alone is a full ChatGPT subscription connection (current
    // vs. legacy secret name) — two alternative single-var methods, not one
    // AND-of-both requirement. Matches the `hasCodexSubscription` OR check in
    // use-connected-providers.ts.
    authRequirement: {
      methods: [
        { envVars: [CODEX_AUTH_JSON_SECRET_NAME] },
        { envVars: [LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME] },
      ],
    },
    helpUrl: null,
    hint: 'ChatGPT Plus or Pro subscription',
    models,
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

/**
 * The literal model id you'd pass as `model` in a gateway request body
 * (`POST /v1/chat/completions`, `/v1/messages`, …) — `provider/model` for
 * BYOK providers (e.g. `anthropic/claude-sonnet-4.6`), the bare id for
 * Kortix-managed models (single-segment by design — see `@kortix/llm-catalog`'s
 * `MANAGED_MODELS` doc comment), and `codex/<id>` for the ChatGPT-subscription
 * provider.
 */
export function gatewayModelId(
  provider: Pick<LlmProviderEntry, 'id' | 'managed'>,
  modelId: string,
): string {
  if (provider.managed) return modelId;
  if (provider.id === 'codex') return `codex/${modelId}`;
  return `${provider.id}/${modelId}`;
}

/** Compact token-count label — "128K", "1M", "8K". Empty string when falsy/invalid. */
export function formatTokenCount(tokens: number | null | undefined): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1000)}K`;
  return `${tokens}`;
}

/**
 * Per-1M-token USD rate, formatted with just enough precision to stay
 * meaningful at sub-cent values (a lot of models.dev input rates are
 * $0.0X–$0.X per 1M). Empty string when the rate isn't known.
 */
export function formatPricePerMillion(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || Number.isNaN(usd)) return '';
  if (usd <= 0) return 'Free';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
