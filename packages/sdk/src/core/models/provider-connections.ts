/**
 * How a project connects its model providers: the catalogue rows, how each
 * provider is connected (included, a subscription sign-in, an API key), which
 * providers a project's secrets connect, the order the list shows them in, and
 * who may use a new connection.
 *
 * Pure and framework-free. The web's Models page (`packages/ui`) and the TUI's
 * `/providers` screen read the same rules from here, so a provider never shows
 * "connected" on one surface and "available" on the other.
 */

import {
  type CatalogCost,
  type CatalogModalities,
  type CatalogReasoningOption,
  type ProviderAuthRequirement,
  isProviderAuthSatisfied,
  primaryAuthEnvVars,
  providerAuthRequirement,
} from '@kortix/llm-catalog/lite';

import type { AccountSecretResource } from '../rest/projects-client/account-secret-resources';
import type { ConnectorSharing } from '../rest/projects-client/shared';

// ─── The catalogue ───────────────────────────────────────────────────────────

/** One model a provider serves, verbatim from models.dev. */
export interface LlmProviderModel {
  id: string;
  name: string;
  /** Release date when known (YYYY-MM-DD). Absent or null: unknown. */
  released?: string | null;
  description?: string;
  attachment?: boolean;
  reasoning?: boolean;
  /** Present iff the model exposes a tunable reasoning effort. */
  reasoning_options?: CatalogReasoningOption[];
  tool_call?: boolean;
  /** false: fixed temperature. */
  temperature?: boolean;
  structured_output?: boolean;
  /** A boolean, or the response field interleaved reasoning arrives on. */
  interleaved?: boolean | { field?: string };
  open_weights?: boolean;
  knowledge?: string;
  last_updated?: string;
  family?: string;
  modalities?: CatalogModalities;
  limit?: { context?: number; input?: number; output?: number };
  cost?: CatalogCost;
}

/** One provider row of the catalogue. */
export interface LlmProviderEntry {
  id: string;
  /** Display name, verbatim from models.dev. */
  label: string;
  /** The fields a key form collects: the primary auth method's env vars. */
  envVars: string[];
  /** Every auth method. "Connected" means any one of them is satisfied. */
  authRequirement: ProviderAuthRequirement;
  /** Where the user gets a key. */
  helpUrl: string | null;
  /** Lowercased host of the provider's API base URL. Null when unknown; never guessed. */
  apiHost: string | null;
  /** One line derived from the model list ("Model A, Model B +12 more"). */
  hint: string;
  models: LlmProviderModel[];
  /** In the curated set that leads the catalogue. */
  featured: boolean;
  /** The Kortix gateway: no key, no connect flow. */
  managed?: boolean;
}

/** One provider of `GET /projects/:id/llm-catalog/providers`, or of the baked seed. */
export interface LlmProviderSource {
  id: string;
  name: string;
  env?: string[];
  doc?: string | null;
  /** Base URL of the provider's API. Absent for providers whose SDK hardcodes it. */
  api?: string | null;
  models: LlmProviderModel[];
}

/** The catalogue as the API serves it (or the baked seed). */
export interface LlmProviderCatalogSource {
  source?: string;
  fetched_at?: string;
  provider_count?: number;
  model_count?: number;
  providers: LlmProviderSource[];
}

/** The curated set that leads the catalogue, in this order. */
const FEATURED_IDS = [
  'anthropic', 'openai', 'google', 'openrouter', 'vercel', 'github-copilot', 'groq', 'xai',
  'deepseek', 'mistral', 'cerebras', 'togetherai', 'fireworks-ai', 'perplexity', 'amazon-bedrock',
  'azure', 'google-vertex', 'huggingface', 'cohere', 'cohere-platform', 'nvidia', 'kortix',
];
const FEATURED_INDEX = new Map(FEATURED_IDS.map((id, index) => [id, index]));

function deriveHint(raw: LlmProviderSource): string {
  if (raw.models.length === 0) return 'No models';
  const names = raw.models.slice(0, 2).map((model) => model.name);
  const remaining = raw.models.length - names.length;
  return remaining > 0 ? `${names.join(', ')} +${remaining} more` : names.join(', ');
}

function deriveApiHost(raw: LlmProviderSource): string | null {
  if (!raw.api) return null;
  try {
    return new URL(raw.api).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

function toEntry(raw: LlmProviderSource): LlmProviderEntry {
  return {
    id: raw.id,
    label: raw.name,
    // The primary method's fields, not raw.env: models.dev lists aliases and
    // auth paths Kortix's transport does not implement (Bedrock's SigV4 pair).
    envVars: primaryAuthEnvVars(raw),
    authRequirement: providerAuthRequirement(raw),
    helpUrl: raw.doc ?? null,
    apiHost: deriveApiHost(raw),
    hint: deriveHint(raw),
    models: raw.models,
    featured: FEATURED_INDEX.has(raw.id),
  };
}

/** The catalogue's providers as rows: the featured set first, in its order, then A-Z. */
export function buildLlmProviderCatalog(raw: LlmProviderCatalogSource): LlmProviderEntry[] {
  return raw.providers.map(toEntry).sort((a, b) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (a.featured) return (FEATURED_INDEX.get(a.id) ?? 0) - (FEATURED_INDEX.get(b.id) ?? 0);
    return a.label.localeCompare(b.label);
  });
}

// ─── Which providers a project's secrets connect ─────────────────────────────

/** The secret a ChatGPT sign-in writes. Its models appear under provider `codex`. */
export const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';
/**
 * The legacy runtime auth row an old ChatGPT sign-in wrote. A ChatGPT sign-in
 * writes `CODEX_AUTH_JSON` now. The connection checks still count this name and
 * a disconnect still deletes it.
 * @deprecated No sign-in writes this secret. Read `CODEX_AUTH_JSON_SECRET_NAME`. Removed in the next major.
 */
export const LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME = 'OPENCODE_AUTH_JSON';

/**
 * The providers a project's secret names connect: every catalogue provider
 * with one auth method fully satisfied, plus `codex` for a ChatGPT sign-in.
 * Pooled account connections are listed separately (`accounts.secretResources`).
 */
export function providerIdsWithCredentials(
  entries: readonly Pick<LlmProviderEntry, 'id' | 'authRequirement'>[],
  secretNames: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  if (secretNames.has(CODEX_AUTH_JSON_SECRET_NAME) || secretNames.has(LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME)) {
    ids.add('codex');
  }
  for (const entry of entries) {
    if (entry.id === 'kortix') continue;
    if (isProviderAuthSatisfied(entry.authRequirement, (name) => secretNames.has(name))) ids.add(entry.id);
  }
  return ids;
}

// ─── How a provider is connected ─────────────────────────────────────────────

/** The three providers that lead the list after Kortix. */
export const FIRST_CLASS_PROVIDER_IDS = ['anthropic', 'openai', 'google'] as const;

/** A subscription a provider signs in with. */
export interface ProviderSubscription {
  kind: 'chatgpt' | 'claude' | 'opencode-go';
  /** "ChatGPT" in "Sign in with ChatGPT". */
  name: string;
  /** The plan the sign-in needs. */
  plan: string;
  /** The device-code provider of `secrets.startProviderOAuth`. Null: Claude, which pastes a code. */
  oauthProvider: string | null;
  /** The provider id the signed-in models and pooled accounts appear under. */
  modelProviderId: string;
}

/** The providers that offer a subscription sign-in beside the API key. */
export const PROVIDER_SUBSCRIPTIONS: Readonly<Record<string, ProviderSubscription>> = {
  openai: { kind: 'chatgpt', name: 'ChatGPT', plan: 'ChatGPT Plus or Pro', oauthProvider: 'openai', modelProviderId: 'codex' },
  // Claude models run through Claude Code on the member's own plan.
  anthropic: { kind: 'claude', name: 'Claude', plan: 'Claude Pro or Max', oauthProvider: null, modelProviderId: 'claude-agent' },
  'opencode-go': { kind: 'opencode-go', name: 'OpenCode', plan: 'OpenCode Go', oauthProvider: 'opencode-go', modelProviderId: 'opencode-go' },
};

/** How a provider is connected. */
export type ProviderConnectMethod = 'included' | 'key' | 'signIn' | 'signInOrKey';

export function providerConnectMethod(entry: Pick<LlmProviderEntry, 'id' | 'envVars' | 'managed'>): ProviderConnectMethod {
  if (entry.managed || entry.id === 'kortix') return 'included';
  if (PROVIDER_SUBSCRIPTIONS[entry.id]) return 'signInOrKey';
  return entry.envVars.length === 0 ? 'signIn' : 'key';
}

/** How a connected two-way provider is connected. */
export type ProviderConnectedVia = 'signIn' | 'key' | 'both';

/** OpenAI's sign-in connects as `codex` and its key as `openai`. Other providers: undefined. */
export function providerConnectedVia(providerId: string, connectedIds: ReadonlySet<string>): ProviderConnectedVia | undefined {
  if (providerId !== 'openai') return undefined;
  const signIn = connectedIds.has('codex');
  const key = connectedIds.has('openai');
  return signIn && key ? 'both' : signIn ? 'signIn' : key ? 'key' : undefined;
}

// Mirrors the gateway's base-URL fallbacks: a provider without an API host or
// one of these cannot back a pooled key.
const GATEWAY_BASE_URL_FALLBACK_IDS = new Set([
  'anthropic', 'openai', 'google', 'groq', 'x-ai', 'xai', 'mistral', 'deepseek',
  'perplexity', 'cerebras', 'vercel', 'v0', 'deepinfra', 'togetherai',
]);

/** A provider whose key can be stored as a named, shareable account key. */
export function supportsPooledProviderKey(entry: Pick<LlmProviderEntry, 'id' | 'envVars' | 'apiHost'> | undefined): boolean {
  return Boolean(entry && entry.envVars.length === 1 && (entry.apiHost || GATEWAY_BASE_URL_FALLBACK_IDS.has(entry.id)));
}

/** What removing a provider's project credentials deletes. */
export function providerDisconnectPlan(provider: Pick<LlmProviderEntry, 'id' | 'envVars'>): {
  /** Remove with `secrets.removeProviderOAuth(...)`. */
  oauthProvider: string | null;
  /** Remove each with `secrets.remove(name)`. */
  secretNames: string[];
} {
  const removesSubscription = provider.id === 'codex' || provider.id === 'openai';
  const names = new Set(provider.envVars.filter((name) => name !== CODEX_AUTH_JSON_SECRET_NAME));
  if (removesSubscription) names.add(LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME);
  return { oauthProvider: removesSubscription ? 'openai' : null, secretNames: [...names] };
}

/**
 * The list order. No search: the first-class ids in their order, then every
 * other provider in catalogue order. A search: every match (label, id or
 * env var), in catalogue order. Connecting a provider never moves its row.
 */
export function orderProviderRows<T extends Pick<LlmProviderEntry, 'id' | 'label' | 'envVars'>>(input: {
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
    .filter((provider): provider is T => Boolean(provider));
  const shown = new Set(firstClass.map((provider) => provider.id));
  return [...firstClass, ...input.providers.filter((provider) => !shown.has(provider.id))];
}

// ─── Who may use a new connection ────────────────────────────────────────────

/**
 * Who can use a new provider connection. "Only you" shares it with nobody, so
 * any project member may create it. "Everyone" and "Specific members" share a
 * credential, which the API gates on `project.secret.write`.
 */
export type ConnectionAccessChoice = 'private' | 'project' | 'members';

/** Access fields for a new account key (`accounts.secretResources.create`). The API always grants the creator. */
export function providerKeyAccessFields(
  choice: ConnectionAccessChoice,
  memberIds: string[],
): { access_mode: 'project' | 'members'; user_ids: string[] } {
  if (choice === 'project') return { access_mode: 'project', user_ids: [] };
  return { access_mode: 'members', user_ids: choice === 'members' ? memberIds : [] };
}

/** Sharing for a new ChatGPT or Claude account. Before the viewer is known, an empty member list keeps it owner-only. */
export function connectionSharing(
  choice: ConnectionAccessChoice,
  memberIds: string[],
  viewerId: string | undefined,
): ConnectorSharing {
  if (choice === 'project') return { mode: 'project' };
  if (choice === 'members' && memberIds.length) return { mode: 'members', memberIds };
  return viewerId ? { mode: 'private', ownerId: viewerId } : { mode: 'members', memberIds: [] };
}

/** The first name in a new account's default label ("ChatGPT · Ada"). */
export function connectionLabelOwnerName(
  user: { email?: string | null; user_metadata?: Record<string, unknown> } | null | undefined,
): string {
  const metadata = user?.user_metadata ?? {};
  for (const key of ['full_name', 'name']) {
    const value = metadata[key];
    const first = typeof value === 'string' ? value.trim().split(/\s+/)[0] : '';
    if (first) return first;
  }
  return user?.email?.split('@')[0] ?? '';
}

export type ConnectionAccessSummary =
  | { kind: 'project' }
  | { kind: 'you' }
  | { kind: 'owner'; ownerId: string }
  | { kind: 'members'; count: number };

/** The access line on a connection row. Granted to its creator alone = private. */
export function connectionAccessSummary(
  secret: Pick<AccountSecretResource, 'access_mode' | 'granted_user_ids' | 'created_by'>,
  viewerId: string | undefined,
): ConnectionAccessSummary {
  if (secret.access_mode === 'project') return { kind: 'project' };
  const grantees = secret.granted_user_ids;
  if (grantees.length === 1 && grantees[0] === secret.created_by) {
    return secret.created_by === viewerId ? { kind: 'you' } : { kind: 'owner', ownerId: secret.created_by };
  }
  return { kind: 'members', count: grantees.length };
}

/** A sign-in account whose login stopped working (marked by the gateway, or inactive). Reconnecting clears it. */
export function connectionNeedsReconnection(secret: Pick<AccountSecretResource, 'active' | 'needs_reauth_at'>): boolean {
  return !secret.active || Boolean(secret.needs_reauth_at);
}
