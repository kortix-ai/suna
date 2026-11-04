
import type { UiTranslator } from '../../../i18n';
import type { LlmProviderEntry, LlmProviderModel } from '../../../internal/lib/llm-providers';

import { CODEX_AUTH_JSON_SECRET_NAME, LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME } from './constants';
import type { ActiveTab } from './types';

export { orderProviderRows, providerDisconnectPlan } from '@kortix/sdk';

type RuntimeProvidersSnapshot =
  | {
      connected?: string[];
      // `name` is on the SDK's Provider type; the builder only reads the fields
      // below from the snapshot, so the local shape names those. The runtime
      // answer is a superset (`packages/sdk` runtime-types `Provider`).
      all?: Array<{ id: string; name?: string; models?: Record<string, unknown> }>;
    }
  | undefined;

export function buildCodexProvider(
  ocProviders: RuntimeProvidersSnapshot,
  tI18nComplete: UiTranslator,
): LlmProviderEntry {
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
    label: tI18nComplete.raw('text50a412294327'),
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
    // Synthetic entry: no models.dev row, so no vendor API host.
    apiHost: null,
    hint: tI18nComplete.raw('texta527a1778404'),
    models,
    featured: true,
  };
}

/**
 * The managed Kortix provider entry for the connected list, or null.
 *
 * Connected means "this gateway can serve a managed model you may use". The
 * runtime provider snapshot always marks `kortix` connected when the gateway
 * exists (`provider-selection.ts` hardcodes it), but the catalog it carries is
 * plan-gated: a free-tier account whose deployment has no servable platform
 * default gets an EMPTY managed set. Reporting that as a connected provider
 * with zero models is the "Kortix · Paid from credits · 0 models" row the
 * model picker contradicts with "No models available" (KRTX-1482), so an empty
 * served set returns null — the row then renders not-connected under the same
 * upgrade story the picker shows. Self-hosts (KORTIX_MANAGED_PROVIDER_ENABLED
 * off) were already handled by the caller's flag check; this rule covers the
 * cloud plan state the flag cannot see.
 *
 * Pure and exported so both rules are pinned by tests; the hook only wires
 * inputs in.
 */
export function buildKortixManagedProvider(
  ocProviders: RuntimeProvidersSnapshot,
  includedHint: string,
): LlmProviderEntry | null {
  const connectedIds = new Set(ocProviders?.connected ?? []);
  const kortix = (ocProviders?.all ?? []).find((p) => p.id === 'kortix');
  if (!kortix || !connectedIds.has('kortix')) return null;
  const models: LlmProviderModel[] = [];
  for (const [id, m] of Object.entries(kortix.models ?? {})) {
    // Managed = served under the `kortix` provider: what Platinum Inference
    // offers. Capabilities and limits come with the served entry.
    const raw = m as {
      name?: string;
      provider?: string;
      release_date?: string;
      reasoning?: boolean;
      tool_call?: boolean;
      attachment?: boolean;
      limit?: { context?: number; output?: number };
    };
    if (raw.provider !== 'kortix' || id.includes('/')) continue;
    models.push({
      id,
      name: (raw.name || id).replace('(latest)', '').trim(),
      released: raw.release_date ?? null,
      reasoning: raw.reasoning,
      tool_call: raw.tool_call,
      attachment: raw.attachment,
      limit: raw.limit,
    });
  }
  if (models.length === 0) return null;
  return {
    id: 'kortix',
    label: kortix.name || 'Kortix',
    envVars: [],
    authRequirement: { methods: [] },
    helpUrl: null,
    // Synthetic entry: no models.dev row, so no vendor API host.
    apiHost: null,
    hint: includedHint,
    models,
    featured: true,
    managed: true,
  };
}

/**
 * The managed provider row's note on the "Add a key" grid.
 *
 * When the served catalog carries managed models, the note explains billing
 * ("no API key needed"). When it carries NONE, that copy invites a key-free
 * connection the picker refuses — the same free-tier contradiction as the
 * connected flag above (KRTX-1482) — so the note takes the upgrade path
 * instead, the story the picker's empty state already tells.
 */
export function managedProviderHint(
  models: readonly unknown[],
  copy: { managedDescription: string; managedUpgradeHint: string },
): string {
  return models.length === 0 ? copy.managedUpgradeHint : copy.managedDescription;
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

export function prettyFieldLabel(envVar: string): string {
  const trimmed = envVar
    .replace(/^[A-Z0-9]+_/, '')
    .replace(/_/g, ' ')
    .toLowerCase();
  const upper = trimmed.toUpperCase();
  // OPENCODE_GO_API_KEY, ZAI_CODING_PLAN_API_KEY: the row already names the provider.
  if (upper.endsWith('API KEY')) return 'API key';
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

/** Compact token-count label — "128K", "1M", "8K". Empty string when falsy/invalid. */
export function formatTokenCount(tokens: number | null | undefined): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    // 1,048,576 reads "1M", not "1.0M".
    return `${Number(Math.round((tokens / 1_000_000) * 10) / 10)}M`;
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
  if (usd < 1) return `$${usd.toFixed(Number.isInteger(usd * 1_000) ? 3 : 4)}`;
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
