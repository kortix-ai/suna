/**
 * The `/providers` screen's data, as plain functions: the list rows, the line
 * under each row, the access line on an account, and which sheet a provider
 * opens. The rules come from `@kortix/sdk` (`provider-connections`), the same
 * ones the web Models page reads; this file only arranges them for a terminal.
 */

import {
  type AccountSecretResource,
  type ConnectionAccessSummary,
  FIRST_CLASS_PROVIDER_IDS,
  type LlmProviderEntry,
  type LlmProviderModel,
  PROVIDER_SUBSCRIPTIONS,
  type ProviderConnectMethod,
  type ProviderConnectedVia,
  orderProviderRows,
  providerConnectMethod,
  providerConnectedVia,
  supportsPooledProviderKey,
} from '@kortix/sdk';

export type ProviderStatus = 'included' | 'connected' | 'none';

export interface ProviderRow {
  id: string;
  label: string;
  method: ProviderConnectMethod;
  modelCount: number;
  hint: string;
  status: ProviderStatus;
  via?: ProviderConnectedVia;
  /** Inference turned off for this project. Credentials are kept. */
  disabled: boolean;
}

/** Kortix's own models, from the served model-picker catalogue: the ids without a provider prefix. */
export function managedProviderEntry(
  pickerModels: Record<string, { name?: string; enabled?: boolean } & Partial<LlmProviderModel>> | undefined,
): LlmProviderEntry {
  const models: LlmProviderModel[] = Object.entries(pickerModels ?? {})
    .filter(([id, model]) => !id.includes('/') && model.enabled !== false)
    .map(([id, model]) => ({
      id,
      name: model.name || id,
      description: model.description,
      reasoning: model.reasoning,
      tool_call: model.tool_call,
      attachment: model.attachment,
      limit: model.limit,
    }));
  return {
    id: 'kortix',
    label: 'Kortix',
    envVars: [],
    authRequirement: { methods: [] },
    helpUrl: null,
    apiHost: null,
    hint:
      models.length === 0
        ? "Upgrade to use Kortix's managed models, or connect your own provider."
        : 'Models from Platinum Inference, paid from credits. No API key needed.',
    models,
    featured: true,
    managed: true,
  };
}

export interface ProviderRowsInput {
  /** The catalogue (`buildLlmProviderCatalog`), without Kortix. */
  catalogue: readonly LlmProviderEntry[];
  /** Kortix's row. Listed first when present. */
  managed: LlmProviderEntry | null;
  /** `providerIdsWithCredentials` of the project's secret names. */
  connectedIds: ReadonlySet<string>;
  /** Providers with a usable pooled account key. */
  pooledIds: ReadonlySet<string>;
  disabledProviders: ReadonlySet<string>;
  search: string;
}

/** The two groups the web lists: In use (included or connected) and Available. Order never depends on status. */
export function providerRows(input: ProviderRowsInput): { inUse: ProviderRow[]; available: ProviderRow[] } {
  const searchable = [
    ...(input.managed ? [input.managed] : []),
    ...input.catalogue.filter((entry) => entry.id !== 'kortix'),
  ];
  const ordered = orderProviderRows({
    providers: searchable,
    firstClassIds: ['kortix', ...FIRST_CLASS_PROVIDER_IDS],
    connectedIds: input.connectedIds,
    search: input.search,
  });
  const rows = ordered.map((entry): ProviderRow => {
    const method = providerConnectMethod(entry);
    const connected =
      input.connectedIds.has(entry.id) ||
      input.pooledIds.has(entry.id) ||
      // A ChatGPT sign-in connects OpenAI as provider `codex`; a Claude account as `claude-agent`.
      (entry.id === 'openai' && (input.connectedIds.has('codex') || input.pooledIds.has('codex'))) ||
      (entry.id === 'anthropic' && input.pooledIds.has('claude-agent'));
    return {
      id: entry.id,
      label: entry.label,
      method,
      modelCount: entry.models.length,
      hint: entry.hint,
      status: method === 'included' ? (entry.models.length > 0 ? 'included' : 'none') : connected ? 'connected' : 'none',
      via: providerConnectedVia(entry.id, input.connectedIds),
      disabled: input.disabledProviders.has(entry.id),
    };
  });
  return {
    inUse: rows.filter((row) => row.status !== 'none'),
    available: rows.filter((row) => row.status === 'none'),
  };
}

const plural = (count: number, one: string, other: string) => `${count} ${count === 1 ? one : other}`;

/** "API key · 14 models": the line under a row and the sheet's subtitle. The web's wording. */
export function providerMeta(row: Pick<ProviderRow, 'id' | 'method' | 'modelCount' | 'via' | 'hint'>): string {
  if (row.method === 'included' && row.modelCount === 0) return row.hint;
  const plan = PROVIDER_SUBSCRIPTIONS[row.id]?.plan;
  const how =
    row.method === 'included'
      ? 'Paid from credits · Platinum Inference'
      : row.method === 'signIn'
        ? 'Sign in'
        : row.method === 'signInOrKey'
          ? row.via === 'both' && plan
            ? `${plan} plan and API key`
            : row.via === 'signIn' && plan
              ? `${plan} plan`
              : row.via === 'key'
                ? 'API key'
                : 'Sign in or API key'
          : 'API key';
  return row.modelCount > 0 ? `${how} · ${plural(row.modelCount, 'model', 'models')}` : how;
}

/** The access line on an account row. `email` names another member's private account. */
export function accessLine(summary: ConnectionAccessSummary, ownerEmail?: string): string {
  if (summary.kind === 'project') return 'Everyone in this workspace';
  if (summary.kind === 'you') return 'Only you';
  if (summary.kind === 'owner') return ownerEmail ? `Only ${ownerEmail}` : '1 member';
  return plural(summary.count, 'member', 'members');
}

/**
 * Which body a provider's sheet shows: the web's `ProviderSheet` branch order.
 * `pooled-*` lists named accounts with sharing (flag `pooled_provider_secrets`,
 * on by default); the others are the project-wide credential flows.
 */
export type ProviderSheetKind =
  | 'included'
  | 'pooled-chatgpt'
  | 'pooled-claude'
  | 'pooled-key'
  | 'subscription'
  | 'no-key'
  | 'key';

export function providerSheetKind(
  entry: Pick<LlmProviderEntry, 'id' | 'envVars' | 'apiHost' | 'managed'>,
  pooled: boolean,
): ProviderSheetKind {
  if (providerConnectMethod(entry) === 'included') return 'included';
  if (pooled && entry.id === 'openai') return 'pooled-chatgpt';
  if (pooled && entry.id === 'anthropic') return 'pooled-claude';
  if (pooled && supportsPooledProviderKey(entry)) return 'pooled-key';
  if (PROVIDER_SUBSCRIPTIONS[entry.id]) return 'subscription';
  if (entry.envVars.length === 0) return 'no-key';
  return 'key';
}

/** The accounts of one provider an account list shows. */
export function accountsFor(
  secrets: readonly AccountSecretResource[] | undefined,
  providerId: string,
): AccountSecretResource[] {
  return (secrets ?? []).filter((secret) => secret.provider_id === providerId);
}

/** "1,000,000" tokens → "1M", 128000 → "128K". The model list's context column. */
export function formatTokens(tokens: number | null | undefined): string {
  if (!tokens || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
