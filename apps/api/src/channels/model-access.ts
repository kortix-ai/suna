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
import { eq } from 'drizzle-orm';
import { projects, sessionProviderSecretPools } from '@kortix/db';
import { db } from '../shared/db';
import { projectFeatureFlagEnabled } from '../feature-flags/for-project';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { servableProjectCatalog } from '../llm-gateway/models/servable-catalog';
import { platformDefaultModelId } from '../llm-gateway/models/served-managed-models';
import { resolveCatalogUpstream } from '../llm-gateway/models/provider-registry';
import { runtimeModelCatalog } from '../llm-gateway/models/runtime-catalog';
import { isModelServableForAccount, resolveEffectiveModel } from '../llm-gateway/resolution/default-model';
import { toOpencodeModelRef, toWireModel } from '../llm-gateway/resolution/effective';
import { resolveSessionPersonalOwner } from '../projects/lib/personal-resources';
import { listUsableGatewaySecrets } from '../secrets/account-resource';
import { channelModelContext, projectModelContext } from './slack/model-gate';
import type { ChannelCtx } from './slack/selection';
import { channelTurnModel } from './vision-model';

type AgentGrantEnv = () => Promise<readonly string[] | 'all' | null>;

/** Most keys one session may select per provider (provider-secret-pools.ts). */
const MAX_KEYS_PER_PROVIDER = 10;

export interface ChannelModelScope {
  projectId: string;
  accountId: string;
  /** Lists and checks run as this member. */
  memberUserId: string;
  /** The linked Kortix user of the person typing; null for an unlinked person (the member is then the account owner). */
  linkedUserId: string | null;
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
    linkedUserId: input.linkedUserId,
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

/** `loadChannelModelScope` for a project row the caller already holds. */
export async function projectChannelModelScope(
  project: { projectId: string; accountId: string; metadata: unknown },
  person: { linkedUserId: string | null; oneToOne: boolean },
): Promise<ChannelModelScope> {
  const gate = await projectModelContext(project);
  return channelModelScope({ ...gate, pooledEnabled: resolveFeatureFlag(project.metadata, 'pooled_provider_secrets'), ...person });
}

/** How a model is reached, for the picker's grouping. */
export type ChannelModelVia = 'chatgpt' | 'key' | 'kortix';

export interface ChannelModelOption {
  /** The gateway wire id (`anthropic/claude-opus-4-8`, `codex/gpt-6-astra`, a bare Kortix id). */
  id: string;
  label: string;
  /** The upstream provider id (`anthropic`, `codex`, `kortix`). */
  provider: string;
  /** Its display name (`Anthropic`, `OpenRouter`). */
  providerLabel: string;
  via: ChannelModelVia;
}

/** A provider's display name from the model catalog; the id when the catalog does not know it. */
export function providerLabel(providerId: string): string {
  if (providerId === 'codex') return 'ChatGPT';
  if (!providerId || providerId === 'kortix') return 'Kortix';
  try {
    const name = runtimeModelCatalog.snapshot().providers.find((p) => p.id === providerId)?.name;
    if (name) return name;
  } catch {
    // Catalog not loaded yet: the id is still a truthful name.
  }
  return providerId;
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
      return {
        id,
        label: typeof model.name === 'string' && model.name ? model.name : id,
        provider,
        providerLabel: providerLabel(provider),
        via: viaOf(id, provider),
      };
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

/**
 * May the running agent use keys stored under `envVar`? The gateway refuses a
 * selected key the agent's secret grant leaves out. `null` / `'all'` = an
 * unrestricted agent; a grant that cannot be read allows nothing.
 */
async function agentMayUseKeys(agentGrantEnv: AgentGrantEnv | undefined, envVar: string): Promise<boolean> {
  if (!agentGrantEnv) return true;
  const env = await agentGrantEnv().catch(() => [] as readonly string[]);
  return env === null || env === 'all' || env.some((name) => name.toUpperCase() === envVar.toUpperCase());
}

/** `channelKeySelection`, or null when the running agent may not use those keys. */
async function grantedKeySelection(
  scope: ChannelModelScope,
  model: string,
  agentGrantEnv: AgentGrantEnv | undefined,
): Promise<ChannelKeySelection | null> {
  const keys = await channelKeySelection(scope, model);
  return keys && (await agentMayUseKeys(agentGrantEnv, keys.envVar)) ? keys : null;
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
    agentGrantEnv?: AgentGrantEnv;
    /** A live session, whose saved selection counts when no new one is made. */
    sessionId?: string;
  } = {},
): Promise<ChannelModelVerdict> {
  const keys = await channelKeySelection(scope, model);
  if (keys && !(await agentMayUseKeys(options.agentGrantEnv, keys.envVar))) {
    return { ok: false, reason: 'agent_grant', envVar: keys.envVar, providerId: keys.providerId };
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

/**
 * The env names a conversation's agent may use, resolved once, on first use.
 * A failed read is `[]` — nothing allowed — so a model is never approved for
 * an agent whose grant could not be checked. `null` = an unrestricted agent.
 */
export function agentGrantEnvFor(projectId: string, agentName: string | null | undefined): AgentGrantEnv {
  let memo: Promise<readonly string[] | 'all' | null> | null = null;
  return () => {
    memo ??= (async () => {
      const [project] = await db.select().from(projects).where(eq(projects.projectId, projectId)).limit(1);
      if (!project) return [];
      // Lazily imported: the manifest reader pulls in the git layer.
      const { resolveAgentGrant } = await import('../projects/agents');
      const grant = await resolveAgentGrant(agentName || 'default', project as never).catch(() => undefined);
      if (grant === undefined) return [];
      return (grant as { env?: readonly string[] | 'all' } | null)?.env ?? null;
    })();
    return memo;
  };
}

/**
 * The scope a live session's turns run in, as the gateway resolves it: as the
 * session's owner, with personal keys only where the gateway uses them too —
 * the session is private to that person and acts on their behalf (spec
 * 2026-09-22 §2.3). A chat session created before one-to-one chats became
 * private is shared, whatever the chat is.
 */
export async function sessionModelScope(
  scope: ChannelModelScope,
  session: { sessionId: string; ownerUserId: string | null },
): Promise<ChannelModelScope> {
  const memberUserId = session.ownerUserId ?? scope.memberUserId;
  let personalUserId: string | null = null;
  if (scope.personalUserId) {
    const owner = await resolveSessionPersonalOwner({
      projectId: scope.projectId,
      accountId: scope.accountId,
      sessionId: session.sessionId,
      legacyUserId: memberUserId,
    }).catch(() => null);
    personalUserId = owner === scope.personalUserId ? owner : null;
  }
  return { ...scope, memberUserId, personalUserId };
}

export interface ChannelSessionStart {
  /** The model to pin; null leaves it to the server's default. */
  model: string | null;
  /** The key selection the session starts with (`provider_secret_pools`). */
  pools?: Record<string, string[]>;
}

/**
 * The model and keys a NEW chat session starts with.
 *
 * The conversation's `/model` choice, checked with every key this
 * conversation may use for it: a model reached only through a shared key or a
 * ChatGPT subscription was checked without them, found unservable and
 * replaced. An image on a text-only model, or a choice that is no longer
 * servable, is replaced as before (channels/vision-model.ts).
 *
 * With no choice, a shared conversation still gets its default checked here.
 * The server resolves a default as if the creator's own keys applied; in a
 * shared session they do not, so a default reached through one person's
 * ChatGPT subscription failed the first turn with "Connect Codex".
 */
export async function planChannelSessionStart(input: {
  projectId: string;
  accountId: string;
  /** Who the session is created as. */
  userId: string;
  /** Null: no model scope could be read, and the legacy check applies. */
  scope: ChannelModelScope | null;
  /** The conversation's `/model` choice (a native ref when the gateway is off). */
  chosenModel: string | null | undefined;
  agentName: string | null | undefined;
  hasImage: boolean;
  agentGrantEnv?: AgentGrantEnv;
}): Promise<ChannelSessionStart> {
  const { projectId, accountId, userId, scope, hasImage, agentGrantEnv } = input;
  const chosen = input.chosenModel?.trim() || null;
  if (!scope) {
    return { model: (await channelTurnModel({ projectId, accountId, userId, currentModel: chosen, hasImage, agentGrantEnv })) ?? chosen };
  }
  let base = chosen;
  if (!base && scope.llmGatewayEnabled && scope.personalUserId !== userId) {
    const resolved = await resolveEffectiveModel({
      userId,
      accountId,
      projectId,
      agentName: input.agentName || 'default',
      explicit: null,
      freeModelsOnly: scope.freeManagedOnly,
      personalUserId: scope.personalUserId,
    }).catch(() => null);
    base = resolved ? (resolved.model ?? (scope.freeManagedOnly ? null : platformDefaultModelId())) : null;
  }
  const keys = base ? await grantedKeySelection(scope, base, agentGrantEnv) : null;
  const pools = selectionPools(keys);
  const replaced = await channelTurnModel({
    projectId,
    accountId,
    userId,
    currentModel: base,
    hasImage,
    agentGrantEnv,
    personalUserId: scope.personalUserId,
    ...(pools ? { providerSecretPools: pools } : {}),
  });
  const model = replaced ?? base;
  // The keys belong to the model they were selected for. A replacement on
  // another provider runs as that provider normally does.
  const keep = keys && model && keyProviderOf(model)?.providerId === keys.providerId;
  return { model, ...(keep ? { pools } : {}) };
}

/**
 * The model a follow-up in a chat conversation must carry, or null to leave
 * the session's own.
 *
 * The conversation's `/model` choice is the model: a Teams chat keeps one
 * session, so a choice that waited for the next session did nothing. A choice
 * made after the session started travels per prompt, as the web composer's
 * does. Its keys are filled into the session first when it has none for that
 * provider; then the model is checked as the gateway will run it
 * (`sessionModelScope`). An unservable model — a ChatGPT pin in a shared
 * session since agents act as their own principal — is replaced for the turn
 * instead of failing it with "Connect Codex to use this model".
 */
export async function planChannelFollowUp(input: {
  projectId: string;
  accountId: string;
  /** The person typing; used only when no model scope could be read. */
  userId: string;
  scope: ChannelModelScope | null;
  session: { sessionId: string; ownerUserId: string | null; pinnedModel: string | null };
  /** The conversation's `/model` choice. */
  chosenModel: string | null | undefined;
  hasImage: boolean;
  agentGrantEnv?: AgentGrantEnv;
}): Promise<string | null> {
  const { projectId, accountId, session, hasImage, agentGrantEnv } = input;
  if (!input.scope) {
    return channelTurnModel({ projectId, accountId, userId: input.userId, currentModel: session.pinnedModel, hasImage, agentGrantEnv });
  }
  const scope = await sessionModelScope(input.scope, session);
  // Off the gateway a choice is a native `provider/model` ref, which cannot
  // travel per prompt through the `kortix` provider: it waits for `/new`.
  const chosen = scope.llmGatewayEnabled ? input.chosenModel?.trim() || null : null;
  const current = chosen ?? session.pinnedModel;
  if (current) {
    const keys = await grantedKeySelection(scope, current, agentGrantEnv);
    await applyChannelSessionKeys({ sessionId: session.sessionId, keys, replace: false });
  }
  return channelTurnModel({
    projectId,
    accountId,
    userId: scope.memberUserId,
    currentModel: current,
    hasImage,
    agentGrantEnv,
    personalUserId: scope.personalUserId,
    sessionId: session.sessionId,
    explicit: Boolean(chosen) && toWireModel(chosen!) !== (session.pinnedModel ? toWireModel(session.pinnedModel) : null),
  });
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
