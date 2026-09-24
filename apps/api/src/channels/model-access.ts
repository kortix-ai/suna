/**
 * Which models a chat conversation (Teams, Slack) may run, and which provider
 * keys pay for them.
 *
 * The web picker lists every model the signed-in person can reach: Kortix
 * models, providers connected with an API key, and ChatGPT subscriptions —
 * including keys another member shared and keys that rotate
 * (`pooled_provider_secrets`). The channels listed only Kortix models and one
 * model per legacy project key, checked every choice as the ACCOUNT OWNER, and
 * never sent a key selection, so a model reached through a shared key or a
 * ChatGPT connection was missing from `/models` and rejected by `/model`.
 *
 * One rule decides whose resources count, the same rule the gateway applies
 * at request time (spec 2026-09-22 §2.3):
 *
 *  - the MEMBER is the linked Kortix user of the person typing (the account
 *    owner for an unlinked one). Keys shared with the whole project count for
 *    any member;
 *  - PERSONAL resources — a key granted to one member, a member's own ChatGPT
 *    connection — count only in a one-to-one chat, whose sessions are private
 *    to that person. A group chat or channel is shared: a personal key there
 *    would let everyone in it spend one person's subscription.
 */
import { and, eq } from 'drizzle-orm';
import { sessionProviderSecretPools } from '@kortix/db';
import { db } from '../shared/db';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { servableProjectCatalog } from '../llm-gateway/models/servable-catalog';
import { resolveCatalogUpstream } from '../llm-gateway/models/provider-registry';
import { isModelServableForAccount } from '../llm-gateway/resolution/default-model';
import { toOpencodeModelRef, toWireModel } from '../llm-gateway/resolution/effective';
import { listUsableGatewaySecrets } from '../secrets/account-resource';
import { channelModelContext } from './slack/model-gate';
import type { ChannelCtx } from './slack/selection';

/** Most keys one session may select per provider (provider-secret-pools.ts). */
const MAX_KEYS_PER_PROVIDER = 10;

export interface ChannelModelScope {
  projectId: string;
  accountId: string;
  /** Lists and checks run as this member. */
  memberUserId: string;
  /** Whose personal keys and ChatGPT connection count; null in a shared conversation. */
  personalUserId: string | null;
  freeManagedOnly: boolean;
  llmGatewayEnabled: boolean;
  pooledEnabled: boolean;
}

/** Who a conversation's model decisions are made for. Pure. */
export function channelModelScope(input: {
  projectId: string;
  accountId: string;
  ownerUserId: string;
  freeManagedOnly: boolean;
  llmGatewayEnabled: boolean;
  pooledEnabled: boolean;
  /** The linked Kortix user of the person typing, or null when unlinked. */
  linkedUserId: string | null;
  /** A Teams personal chat or a Slack DM: the conversation's sessions are private to that person. */
  oneToOne: boolean;
}): ChannelModelScope {
  return {
    projectId: input.projectId,
    accountId: input.accountId,
    memberUserId: input.linkedUserId ?? input.ownerUserId,
    // An unlinked person has no personal resources to offer, and the account
    // owner's must never stand in for them.
    personalUserId: input.linkedUserId && input.oneToOne ? input.linkedUserId : null,
    freeManagedOnly: input.freeManagedOnly,
    llmGatewayEnabled: input.llmGatewayEnabled,
    pooledEnabled: input.pooledEnabled,
  };
}

export async function loadChannelModelScope(
  ctx: ChannelCtx,
  person: { linkedUserId: string | null; oneToOne: boolean },
): Promise<ChannelModelScope | null> {
  const gate = await channelModelContext(ctx);
  if (!gate) return null;
  const pooledEnabled = await projectFeatureFlagEnabled(gate.projectId, 'pooled_provider_secrets').catch(() => false);
  return channelModelScope({ ...gate, pooledEnabled, ...person });
}

/** How a model is reached, for the picker's grouping. */
export type ChannelModelVia = 'chatgpt' | 'key' | 'kortix';

export interface ChannelModelOption {
  /** The gateway wire id (`anthropic/claude-opus-4-8`, `codex/gpt-6-astra`, a bare Kortix id). */
  id: string;
  label: string;
  /** The upstream provider id (`anthropic`, `codex`, `kortix`). */
  provider: string;
  via: ChannelModelVia;
}

const VIA_ORDER: Record<ChannelModelVia, number> = { chatgpt: 0, key: 1, kortix: 2 };

export function viaOf(id: string, provider: string): ChannelModelVia {
  if (id.startsWith('codex/')) return 'chatgpt';
  if (provider === 'kortix' || !id.includes('/')) return 'kortix';
  return 'key';
}

/**
 * The models this conversation may pick: the web picker's own list
 * (`servableProjectCatalog`), for this conversation's member and personal
 * scope, enabled models only. The person's subscriptions and keys first, then
 * Kortix models.
 */
export async function listChannelModels(scope: ChannelModelScope): Promise<{
  models: ChannelModelOption[];
  defaultModel: string | null;
}> {
  const catalog = await servableProjectCatalog({
    projectId: scope.projectId,
    accountId: scope.accountId,
    principalUserId: scope.memberUserId,
    personalUserId: scope.personalUserId,
  });
  const models = Object.entries(catalog.models)
    .filter(([, model]) => model.enabled)
    .map(([id, model]): ChannelModelOption => {
      const provider = typeof model.provider === 'string' ? model.provider : '';
      return { id, label: typeof model.name === 'string' && model.name ? model.name : id, provider, via: viaOf(id, provider) };
    })
    .sort((a, b) => VIA_ORDER[a.via] - VIA_ORDER[b.via] || a.label.localeCompare(b.label));
  return { models, defaultModel: catalog.defaultModel ?? null };
}

/** The provider whose keys pay for a model, and the key name the gateway reads. Null for a Kortix model. */
export function keyProviderOf(model: string): { providerId: string; envVar: string } | null {
  const wire = toWireModel(model);
  if (!wire.includes('/')) return null;
  const providerId = wire.split('/')[0]!;
  if (providerId === 'codex') return { providerId, envVar: 'CODEX_AUTH_JSON' };
  const upstream = resolveCatalogUpstream(providerId);
  return upstream ? { providerId, envVar: upstream.envVar } : null;
}

export interface ChannelKeySelection {
  providerId: string;
  envVar: string;
  secretIds: string[];
  labels: string[];
}

/**
 * Every key this conversation may use for the model's provider, so all of
 * them rotate. Null when there is nothing to select: the flag or the gateway
 * is off, the model is a Kortix model, or no pooled key exists — the legacy
 * project key path then applies, as it does in the web.
 */
export async function channelKeySelection(scope: ChannelModelScope, model: string): Promise<ChannelKeySelection | null> {
  if (!scope.pooledEnabled || !scope.llmGatewayEnabled) return null;
  const provider = keyProviderOf(model);
  if (!provider) return null;
  const keys = (await listUsableGatewaySecrets({
    accountId: scope.accountId,
    projectId: scope.projectId,
    userId: scope.memberUserId,
    grantUserId: scope.personalUserId,
    providerId: provider.providerId,
  }).catch(() => [])).filter((key) => key.name.toUpperCase() === provider.envVar.toUpperCase())
    .slice(0, MAX_KEYS_PER_PROVIDER);
  if (!keys.length) return null;
  return { ...provider, secretIds: keys.map((key) => key.secretId), labels: keys.map((key) => key.label) };
}

export function selectionPools(selection: ChannelKeySelection | null): Record<string, string[]> | undefined {
  return selection ? { [selection.providerId]: selection.secretIds } : undefined;
}

export type ChannelModelVerdict =
  | { ok: true; model: string; keys: ChannelKeySelection | null }
  | { ok: false; reason: 'agent_grant'; envVar: string; providerId: string }
  | { ok: false; reason: 'not_servable' };

/**
 * May this conversation run `model`? Checked as the gateway will run it: for
 * this member and personal scope, with the keys this conversation would
 * select, and the running agent's secret grant.
 */
export async function checkChannelModel(
  scope: ChannelModelScope,
  model: string,
  options: {
    /** The running agent's granted env names, resolved lazily; only read when keys are selected. */
    agentGrantEnv?: () => Promise<readonly string[] | 'all' | null>;
    /** A live session, whose saved selection counts when no new one is made. */
    sessionId?: string;
  } = {},
): Promise<ChannelModelVerdict> {
  const keys = await channelKeySelection(scope, model);
  if (keys && options.agentGrantEnv) {
    const env = await options.agentGrantEnv().catch(() => [] as readonly string[]);
    const allowed = env === null || env === 'all' || env.some((name) => name.toUpperCase() === keys.envVar.toUpperCase());
    if (!allowed) return { ok: false, reason: 'agent_grant', envVar: keys.envVar, providerId: keys.providerId };
  }
  const servable = await isModelServableForAccount({
    userId: scope.memberUserId,
    accountId: scope.accountId,
    projectId: scope.projectId,
    freeModelsOnly: scope.freeManagedOnly,
    model,
    personalUserId: scope.personalUserId,
    ...(keys ? { providerSecretPools: selectionPools(keys) } : options.sessionId ? { sessionId: options.sessionId } : {}),
  }).catch(() => false);
  return servable ? { ok: true, model: toOpencodeModelRef(model), keys } : { ok: false, reason: 'not_servable' };
}

/**
 * Point a live session at the keys its model needs.
 *
 * `replace` (a `/model` change) overwrites the session's selection for that
 * provider with every key the conversation may use now. Otherwise it writes
 * only when the session has no selection for the provider yet — a session
 * started before the conversation picked this model, or before this code —
 * and keeps one a person set on purpose (in the web, an empty one included).
 */
export async function applyChannelSessionKeys(input: {
  sessionId: string;
  keys: ChannelKeySelection | null;
  replace: boolean;
}): Promise<boolean> {
  if (!input.keys || !input.sessionId) return false;
  const values = {
    sessionId: input.sessionId,
    providerId: input.keys.providerId,
    secretIds: input.keys.secretIds,
    updatedAt: new Date(),
  };
  try {
    if (input.replace) {
      await db.insert(sessionProviderSecretPools).values(values).onConflictDoUpdate({
        target: [sessionProviderSecretPools.sessionId, sessionProviderSecretPools.providerId],
        set: { secretIds: values.secretIds, updatedAt: values.updatedAt },
      });
      return true;
    }
    const inserted = await db.insert(sessionProviderSecretPools).values(values)
      .onConflictDoNothing({ target: [sessionProviderSecretPools.sessionId, sessionProviderSecretPools.providerId] })
      .returning({ sessionId: sessionProviderSecretPools.sessionId });
    return inserted.length > 0;
  } catch (err) {
    console.warn('[channels] could not set the session provider keys', {
      sessionId: input.sessionId,
      providerId: input.keys.providerId,
      err: (err as Error)?.message,
    });
    return false;
  }
}

/** Read a live session's selection for one provider: undefined = none saved. */
export async function sessionKeySelection(sessionId: string, providerId: string): Promise<string[] | undefined> {
  const [row] = await db.select({ ids: sessionProviderSecretPools.secretIds }).from(sessionProviderSecretPools)
    .where(and(eq(sessionProviderSecretPools.sessionId, sessionId), eq(sessionProviderSecretPools.providerId, providerId)))
    .limit(1);
  return row?.ids;
}

/** "rotating across 2 keys: Team key, Ivan's key" — for a confirmation. */
export function describeKeys(keys: ChannelKeySelection | null): string | null {
  if (!keys) return null;
  const what = keys.providerId === 'codex' ? 'ChatGPT connection' : 'key';
  const names = keys.labels.slice(0, 3).join(', ') + (keys.labels.length > 3 ? `, +${keys.labels.length - 3}` : '');
  return keys.secretIds.length === 1
    ? `Uses one ${what}: ${names}.`
    : `Rotates across ${keys.secretIds.length} ${what}s: ${names}.`;
}
