import type { LlmProviderEntry, LlmProviderModel } from '@/lib/llm-providers';

import { CODEX_AUTH_JSON_SECRET_NAME, LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME } from './constants';
import type { ActiveTab } from './types';

export function providerCredentialSummary(provider: LlmProviderEntry): string {
  if (provider.id === 'codex') return 'ChatGPT subscription';
  if (provider.id === 'openai') return 'OpenAI API key';
  return provider.envVars.join(' · ');
}

export function providerDisconnectPlan(provider: Pick<LlmProviderEntry, 'id' | 'envVars'>): {
  oauthProvider: string | null;
  secretNames: string[];
} {
  const removesSubscription = provider.id === 'codex' || provider.id === 'openai';
  const names = new Set(provider.envVars.filter((name) => name !== CODEX_AUTH_JSON_SECRET_NAME));
  if (removesSubscription) names.add(LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME);
  return {
    oauthProvider: removesSubscription ? 'openai' : null,
    secretNames: [...names],
  };
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
  const models: LlmProviderModel[] = [];
  if (kortix && connectedIds.has('kortix')) {
    for (const [id, m] of Object.entries(kortix.models ?? {})) {
      if (!id.startsWith('codex/')) continue;
      const raw = m as {
        name?: string;
        release_date?: string;
        released?: string;
        reasoning?: boolean;
        tool_call?: boolean;
        limit?: { context?: number; output?: number };
      };
      models.push({
        id: id.slice('codex/'.length),
        name: (raw.name || id)
          .replace('(latest)', '')
          .trim()
          .replace(/\s*\(ChatGPT\)$/, ''),
        released: raw.release_date ?? raw.released ?? null,
        reasoning: raw.reasoning,
        tool_call: raw.tool_call,
        limit: raw.limit,
      });
    }
  }

  return {
    id: 'codex',
    label: 'ChatGPT',
    envVars: [CODEX_AUTH_JSON_SECRET_NAME, LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME],
    // EITHER secret alone is a full ChatGPT subscription connection (current
    // vs. legacy secret name) — two alternative single-var methods, not one
    // AND-of-both requirement. Matches the `hasCodexSubscription` OR check in
    // use-connected-providers.ts.
    authRequirement: {
      methods: [
        { envVars: [CODEX_AUTH_JSON_SECRET_NAME] },
        { envVars: [LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME] },
      ],
    },
    helpUrl: null,
    hint: 'ChatGPT Plus or Pro subscription',
    models,
    featured: true,
  };
}

/**
 * Which of the modal's two tabs to open on. `models` is the only tab a caller
 * can ask for that is not the default — `providers` already shows both the
 * connected list and the add-a-provider rows (JAY-510), so the old
 * `hasConnections` fallback that folded 'connected'/'models' back to 'catalog'
 * has nothing left to fold.
 */
export function pickInitialTab(defaultTab: ActiveTab | undefined): ActiveTab {
  if (defaultTab === 'models') return 'models';
  if (defaultTab === 'custom') return 'custom';
  return 'providers';
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

/**
 * What an empty credential field says.
 *
 * A multi-field provider gets the field's own PLAIN name — "Secret access
 * key", not `Enter AWS_SECRET_ACCESS_KEY…`. The env-var name is the shape the
 * value is stored under; it is not what the provider's own console calls the
 * thing you are copying, which is the only name that helps you find it.
 */
export function envVarPlaceholder(provider: LlmProviderEntry, envVar: string): string {
  if (provider.envVars.length === 1) {
    return `Paste your ${provider.label} API key…`;
  }
  return prettyFieldLabel(envVar);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The gateway wire id for a model listed under a PROVIDER entry (the "Add
 * provider" catalog, which browses providers rather than the project's served
 * models). Surfaces that work from the served catalog have the wire id already
 * and use `modelKeyToWire` instead — see model-rows.ts.
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

/**
 * Should focus leaving a provider's credential fields actually WRITE?
 *
 * The "Add a key" grid has no Connect button — the save fires when focus
 * leaves the row (`provider-connect.tsx`'s `ProviderKeyFields`). That trigger
 * fires constantly and mostly on rows nobody touched, so the whole safety of
 * the auto-save is this one predicate:
 *
 *  1. **Nothing typed** — tabbing across a screen of empty fields must not
 *     fire a request per row.
 *  2. **Half a credential** — Bedrock needs an id, a secret AND a region.
 *     Saving after the first field stores a credential that cannot
 *     authenticate, and the provider would then report itself connected.
 *  3. **Unchanged** — re-entering and leaving a row you already saved is not
 *     an edit. `savedValues` is the post-success snapshot, so this compares
 *     against what the server actually has rather than a dirty flag that four
 *     call sites would have to remember to clear.
 *
 * Pure and exported so all three rules are pinned by tests; the component only
 * supplies the inputs.
 */
export function shouldSaveCredential(input: {
  providerId: string;
  envVars: string[];
  /** Keyed `${providerId}:${envVar}` — what is in the fields right now. */
  values: Record<string, string>;
  /** Keyed the same way — what the last successful save wrote. */
  savedValues: Record<string, string>;
}): boolean {
  if (input.envVars.length === 0) return false;
  const typed = input.envVars.map((envVar) => {
    const key = `${input.providerId}:${envVar}`;
    return { key, value: (input.values[key] ?? '').trim() };
  });
  if (typed.some(({ value }) => !value)) return false;
  return typed.some(({ key, value }) => input.savedValues[key] !== value);
}

/** The minimum a provider entry needs for `orderProviderRows` to place it. */
export interface OrderableProvider {
  id: string;
  label: string;
  envVars: string[];
}

/**
 * Which providers the API-keys list shows, and IN WHAT ORDER.
 *
 * **Every provider, always.** The list used to show three (the first-class
 * ids) plus whatever already had a key, and hid the other ~185 behind the
 * search field. That is the thing this screen was asked to stop doing: a
 * settings page that answers "which providers can I use?" with three, and
 * only tells you the rest exist if you happen to type a name you already
 * know, is not a list — it is a guess. The whole catalog renders; the search
 * field narrows it.
 *
 * The ORDER is fixed and never depends on whether a provider has a key —
 * that invariant survives unchanged, and it is the defect this function
 * exists to make untestable-to-reintroduce. The list used to sort connected
 * providers into a block above the rest, so finishing a key field made that
 * row jump out of the list you were reading. Now:
 *
 *  - **No search** — the first-class ids in their declared order, then EVERY
 *    other provider in catalog order. Connecting one does not move it.
 *  - **Search** — every catalog match, connected or not, in catalog order.
 *
 * Matching covers label, id and env-var name, so both "bedrock" and
 * "AWS_ACCESS_KEY_ID" find AWS.
 */
export function orderProviderRows<T extends OrderableProvider>(input: {
  providers: T[];
  firstClassIds: readonly string[];
  connectedIds: ReadonlySet<string>;
  search: string;
}): T[] {
  const query = input.search.trim().toLowerCase();
  if (query) {
    return input.providers.filter(
      (provider) =>
        provider.label.toLowerCase().includes(query) ||
        provider.id.toLowerCase().includes(query) ||
        provider.envVars.some((envVar) => envVar.toLowerCase().includes(query)),
    );
  }

  const byId = new Map(input.providers.map((provider) => [provider.id, provider]));
  const firstClass = input.firstClassIds
    .map((id) => byId.get(id))
    .filter((provider): provider is T => !!provider);
  const shown = new Set(firstClass.map((provider) => provider.id));
  // Catalog order for the rest — NOT "connected first". A provider that moves
  // the moment you finish typing in it is the exact regression the fixed order
  // above exists to prevent.
  const rest = input.providers.filter((provider) => !shown.has(provider.id));
  return [...firstClass, ...rest];
}

// ─── Plain-English model descriptions ────────────────────────────────────────
//
// The Models tab used to print the catalog's own numbers at the reader —
// "200K ctx · $3.00 / $15.00 per 1M" — which is precise and, to anyone who has
// not priced an LLM before, unreadable. These helpers restate the SAME three
// facts (context window, price, capabilities) in words. The numbers are not
// deleted: they move behind the tab's "Show technical details" toggle, so the
// row leads with meaning and the exact figure stays one click away.

/**
 * English prose runs roughly ¾ of a word per token — the rule of thumb every
 * provider publishes. Deliberately approximate, and every caller says "about":
 * this exists to let someone picture "a long book" vs "a few emails", not to
 * budget a request.
 */
const WORDS_PER_TOKEN = 0.75;

/** "about 150,000 words" — a context window a non-technical reader can picture. */
export function formatWordCapacity(tokens: number | null | undefined): string {
  if (!tokens || tokens <= 0) return '';
  const words = tokens * WORDS_PER_TOKEN;
  if (words >= 1_000_000) {
    const millions = words / 1_000_000;
    return `about ${Number.isInteger(millions) ? millions : millions.toFixed(1)} million words`;
  }
  if (words >= 1_000) return `about ${Math.round(words / 1_000).toLocaleString('en-US')},000 words`;
  return `about ${Math.round(words).toLocaleString('en-US')} words`;
}

/**
 * A cost band, from the OUTPUT rate per 1M tokens — the side that dominates a
 * chat bill, and the only one whose spread is wide enough to band meaningfully
 * (input rates cluster far more tightly).
 *
 * The wording is a statement about PRICE and nothing else. "Low cost" does not
 * promise a model is worse, and the bands never say "best" or "balanced" —
 * this file has no basis for a quality claim and must not imply one.
 */
export function costBandLabel(outputUsdPerMillion: number | null | undefined): string {
  const usd = outputUsdPerMillion;
  if (usd === null || usd === undefined || Number.isNaN(usd)) return '';
  if (usd <= 0) return 'Free to run';
  if (usd < 2) return 'Low cost';
  if (usd < 15) return 'Mid cost';
  return 'Higher cost';
}

export interface ModelPlainFacts {
  reasoning?: boolean;
  vision?: boolean;
  outputUsdPerMillion?: number | null;
  contextTokens?: number | null;
}

/**
 * The ONE muted line under a model's name — "Mid cost · reads images · holds
 * about 150,000 words".
 *
 * It carries every fact the row used to spend three extra lines on: the price
 * band, the capabilities, and the context window. Ordered cheapest-to-read
 * first: cost decides most choices, capability decides the rest, and size is
 * the tiebreaker nobody starts with.
 *
 * Tool calling is deliberately absent: near every served model has it, so a
 * phrase on 95% of rows carries no information and only adds a word to scan
 * past.
 *
 * Empty string when the catalog knows none of these — the row then renders no
 * subtitle at all rather than a filler phrase that says nothing.
 */
export function modelPlainSummary(facts: ModelPlainFacts): string {
  const parts: string[] = [];
  const cost = costBandLabel(facts.outputUsdPerMillion);
  if (cost) parts.push(cost);
  if (facts.vision) parts.push('reads images');
  if (facts.reasoning) parts.push('thinks before answering');
  const words = formatWordCapacity(facts.contextTokens);
  if (words) parts.push(`holds ${words}`);
  return parts.join(' · ');
}
