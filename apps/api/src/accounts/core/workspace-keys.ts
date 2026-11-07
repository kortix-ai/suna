// Workspace settings › API keys: ONE list of every key of a workspace, and ONE
// mint route that asks who the key acts as (design.md §3.2 C4b).
//
//   acts_as "me"    the caller (a workspace key; `POST …/tokens` unchanged):
//                   the caller's current role ∩ scope; revoked when they leave.
//   acts_as "agent" the agent's own service-account identity: the agent's
//                   kortix.yaml grant ∩ its ceiling ∩ scope, minus HUMAN_ONLY;
//                   audited as the agent; survives its creator leaving.
//   acts_as "bot"   a bot service account (a non-agent machine identity for CI
//                   and integrations): its roles ∩ scope, minus HUMAN_ONLY.
//
// Every key is an `account_tokens` row bound to the workspace (`kortix_pat_`).
// An agent or bot key stores the service account in `user_id` (the principal)
// and the person in `created_by`. A bot created before 2026-11-07 also holds
// its own `kortix_sa_` bearer; the list shows that bearer as a bot key too.
import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { isMyKortixAgentName } from '@kortix/shared';
import { json, errors, auth } from '../../openapi';
import { ACCOUNT_ACTIONS, assertAuthorized, authorize } from '../../iam';
import { actorForToken, actorOf, loadServiceAccountActivation } from '../../iam/actor';
import { assignRole, SYSTEM_ACTOR } from '../../iam/assignments';
import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { parseKeyScopesInput, type KeyScopes } from '../../iam/key-scope';
import { grantsByAgent, loadProjectAgents, loadProjectForUser } from '../../projects/surface';
import {
  PatPolicyError,
  checkTokenMintExpiry,
  createAccountToken,
  deleteRevokedPersonalAccountToken,
  deleteUnissuedAccountToken,
  getAccountTokenOwner,
  getServiceAccountKey,
  listPersonalAccountTokens,
  listServiceAccountKeys,
  resolveMintExpiry,
  revokeAccountToken,
} from '../../repositories/account-tokens';
import {
  createServiceAccount,
  deleteServiceAccount,
  disableServiceAccount,
  ensureAgentServiceAccount,
  findBotServiceAccount,
  getServiceAccount,
  listServiceAccounts,
} from '../../repositories/service-accounts';
import { rethrowDatabaseError } from '../../shared/database-errors';
import { readJsonObject } from '../../shared/http-body';
import { isNoWorkspaceError } from '../../shared/no-workspace';
import { isUuid } from '../../shared/validate';
import { WORKSPACE_AMBIGUOUS_CODE } from '../../workspaces/surface';
import { auditIam, isUniqueViolation } from '../iam/http-helpers';
import { AccountIdParam, accountsRouter, lookupEmailsByUserIds, resolveAccountForUser } from './app';
import {
  actsAsFullIdentity,
  isPersonCaller,
  keyWire,
  mintTokenFromBody,
  pathAccountOf,
  pathTokenBinding,
} from './tokens';

export type KeyPrincipalKind = 'me' | 'agent' | 'bot';

/** The OpenAPI router's handler type, as in `workspaces/routes.ts`: the handlers take a plain `Context`. */
type AnyHandler = any;

const ActsAsSchema = z
  .object({
    type: z.enum(['me', 'agent', 'bot']),
    /** The agent name or bot name; null for `me`. */
    name: z.string().nullable(),
    /** The service account the key authorizes as; null for `me`. */
    service_account_id: z.string().nullable(),
  })
  .openapi('WorkspaceKeyActsAs');

export const WorkspaceKeySchema = z
  .object({
    key_id: z.string(),
    name: z.string(),
    acts_as: ActsAsSchema,
    /** `token`: an `account_tokens` key (`kortix_pat_`). `service_account_bearer`: a bot's own `kortix_sa_` bearer, from before workspace keys. */
    credential: z.enum(['token', 'service_account_bearer']),
    public_key: z.string(),
    status: z.string(),
    expires_at: z.string().nullable(),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
    revoked_at: z.string().nullable(),
    created_by: z.string().nullable(),
    created_by_email: z.string().nullable(),
    scope: z.enum(['full', 'read', 'custom']),
    permissions: z.array(z.string()).nullable(),
    workspace_permissions: z.array(z.string()).nullable(),
    expiry_renews: z.boolean(),
    secret_key: z.string().optional(),
  })
  .openapi('WorkspaceKey');

const KeysListSchema = z
  .object({
    keys: z.array(WorkspaceKeySchema),
    /** True when the caller may mint and revoke agent and bot keys (`token.create`). */
    can_manage_principals: z.boolean(),
    /** The agents a key can act as: every enabled agent of kortix.yaml except My Kortix. Empty without `can_manage_principals`. */
    agents: z.array(z.object({ name: z.string() })),
    /** The workspace's bots. `has_role` false: a key of it can do nothing until the bot is given a role. */
    bots: z.array(z.object({ bot_id: z.string(), name: z.string(), has_role: z.boolean() })),
  })
  .openapi('WorkspaceKeys');

type WorkspaceKeyWire = z.infer<typeof WorkspaceKeySchema>;

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

/** The workspace in the path and its account, or the refusal to send. */
async function keysWorkspace(
  c: Context,
): Promise<{ ok: true; workspaceId: string; accountId: string } | { ok: false; res: Response }> {
  const userId = c.get('userId') as string;
  const binding = await pathTokenBinding(c);
  if (binding.kind === 'ambiguous') {
    return {
      ok: false,
      res: c.json(
        { error: 'This account holds several workspaces. Name one: use /v1/workspaces/<workspace id>/keys.', code: WORKSPACE_AMBIGUOUS_CODE },
        409,
      ),
    };
  }
  if (binding.kind !== 'workspace') return { ok: false, res: c.json({ error: 'Workspace not found' }, 404) };
  try {
    const accountId = await resolveAccountForUser(userId, pathAccountOf(c));
    return { ok: true, workspaceId: binding.projectId, accountId };
  } catch (err) {
    rethrowDatabaseError(err);
    if (isNoWorkspaceError(err)) throw err;
    return { ok: false, res: c.json({ error: (err as Error).message }, 403) };
  }
}

function tokenRow(
  t: {
    tokenId: string;
    name: string;
    publicKey: string;
    status: string;
    expiresAt: Date | null;
    lastUsedAt: Date | null;
    createdAt: Date;
    revokedAt: Date | null;
    scopes: KeyScopes | null;
    expiryRenewDays: number | null;
  },
  actsAs: WorkspaceKeyWire['acts_as'],
  createdBy: string | null,
  emails: Map<string, string | null>,
): WorkspaceKeyWire {
  return {
    key_id: t.tokenId,
    name: t.name,
    acts_as: actsAs,
    credential: 'token',
    public_key: t.publicKey,
    status: t.status,
    expires_at: iso(t.expiresAt),
    last_used_at: iso(t.lastUsedAt),
    created_at: t.createdAt.toISOString(),
    revoked_at: iso(t.revokedAt),
    created_by: createdBy,
    created_by_email: createdBy ? (emails.get(createdBy) ?? null) : null,
    ...keyWire(t),
  };
}

/** The agents a key may act as: enabled kortix.yaml agents with a grant, never My Kortix. Empty when the manifest cannot be read. */
async function keyableAgents(c: Context, workspaceId: string): Promise<Map<string, ReturnType<typeof grantsByAgent> extends Map<string, infer G> ? G : never>> {
  const loaded = await loadProjectForUser(c, workspaceId, 'read');
  if (!loaded?.row) return new Map();
  const agents = await loadProjectAgents(loaded.row, { forceRefresh: 'tip-proof', rethrowReadErrors: true });
  const grants = grantsByAgent(agents);
  for (const name of [...grants.keys()]) if (isMyKortixAgentName(name)) grants.delete(name);
  return grants;
}

/**
 * Every key of the workspace the caller may see: their own workspace keys,
 * and with `token.create` every agent and bot key plus each older bot's own
 * bearer. A person's personal keys (bound to no workspace) are listed in
 * Preferences › Personal keys (`GET /v1/me/tokens`).
 */
async function listKeys(c: Context) {
  if (c.get('authType') === 'service_account') {
    return c.json({ error: 'A service account cannot list keys', code: 'not_a_member' }, 403);
  }
  const userId = c.get('userId') as string;
  const ws = await keysWorkspace(c);
  if (!ws.ok) return ws.res;
  const { workspaceId, accountId } = ws;
  const actor = await actorOf(c, accountId);
  await assertAuthorized(actor, ACCOUNT_ACTIONS.TOKEN_READ);
  const canManage = (await authorize(actor, ACCOUNT_ACTIONS.TOKEN_CREATE)).allowed;

  const mine = (await listPersonalAccountTokens(accountId, userId)).filter((t) => t.projectId === workspaceId);
  const principalKeys = canManage ? await listServiceAccountKeys(accountId, workspaceId) : [];
  const bots = canManage ? (await listServiceAccounts(accountId)).filter((b) => b.agentName === null) : [];
  let agents: string[] = [];
  if (canManage) {
    try {
      agents = [...(await keyableAgents(c, workspaceId)).keys()].sort();
    } catch {
      // An unreadable manifest offers no agent; the list still answers.
      agents = [];
    }
  }
  const creators = new Set<string>([userId]);
  for (const k of principalKeys) if (k.createdBy) creators.add(k.createdBy);
  for (const b of bots) if (b.createdBy) creators.add(b.createdBy);
  const emails = await lookupEmailsByUserIds([...creators]);

  const keys: WorkspaceKeyWire[] = [
    ...mine.map((t) => tokenRow(t, { type: 'me', name: null, service_account_id: null }, userId, emails)),
    ...principalKeys.map((k) =>
      tokenRow(
        k,
        {
          type: k.agentName ? 'agent' : 'bot',
          name: k.agentName ?? k.serviceAccountName,
          service_account_id: k.serviceAccountId,
        },
        k.createdBy,
        emails,
      ),
    ),
    ...bots
      .filter((b) => b.bearerIssued)
      .map(
        (b): WorkspaceKeyWire => ({
          key_id: b.serviceAccountId,
          name: b.name,
          acts_as: { type: 'bot', name: b.name, service_account_id: b.serviceAccountId },
          credential: 'service_account_bearer',
          public_key: b.publicPrefix,
          status: b.status === 'active' ? 'active' : 'revoked',
          expires_at: iso(b.expiresAt),
          last_used_at: iso(b.lastUsedAt),
          created_at: b.createdAt.toISOString(),
          revoked_at: iso(b.disabledAt),
          created_by: b.createdBy,
          created_by_email: b.createdBy ? (emails.get(b.createdBy) ?? null) : null,
          ...keyWire({ scopes: null, expiryRenewDays: null }),
        }),
      ),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const botChoices = await Promise.all(
    bots
      .filter((b) => b.status === 'active')
      .map(async (b) => ({
        bot_id: b.serviceAccountId,
        name: b.name,
        has_role: await loadServiceAccountActivation(b.serviceAccountId, accountId),
      })),
  );
  return c.json({
    keys,
    can_manage_principals: canManage,
    agents: agents.map((name) => ({ name })),
    bots: botChoices,
  });
}

/** `acts_as: agent | bot`: a key that authorizes as a service account. */
async function mintServiceAccountKey(c: Context, body: Record<string, unknown>, kind: 'agent' | 'bot') {
  if (c.get('authType') === 'oauth') {
    return c.json({ error: 'Connected apps cannot mint keys.' }, 403);
  }
  // Only a person mints a key that acts as an agent or a bot: a key that mints
  // one could hand out a principal wider than itself.
  if (!isPersonCaller(c)) {
    return c.json(
      { error: 'Only a person signed in to Kortix (a browser session or a personal key) can create a key for an agent or a bot.', code: 'key_principal_requires_person' },
      403,
    );
  }
  const userId = c.get('userId') as string;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 255) return c.json({ error: 'name too long (max 255 chars)' }, 400);
  const ws = await keysWorkspace(c);
  if (!ws.ok) return ws.res;
  const { workspaceId, accountId } = ws;
  const actor = await actorOf(c, accountId);
  await assertAuthorized(actor, ACCOUNT_ACTIONS.TOKEN_CREATE);

  const parsedScopes = parseKeyScopesInput(body.scopes);
  if (!parsedScopes.ok) return c.json({ error: parsedScopes.error, code: parsedScopes.code }, 400);
  const scopes = parsedScopes.scopes;
  const expiry = await resolveMintExpiry(accountId, Object.hasOwn(body, 'expires_at') ? body.expires_at : undefined);
  if (!expiry.ok) return c.json({ error: expiry.error, code: expiry.code }, expiry.status);
  const expiryRefusal = await checkTokenMintExpiry(expiry.expiresAt, undefined);
  if (expiryRefusal) return c.json({ error: expiryRefusal.error, code: expiryRefusal.code }, expiryRefusal.status);

  let serviceAccountId: string;
  let principalName: string;
  let agentGrant = null;
  if (kind === 'agent') {
    const agent = typeof body.agent === 'string' ? body.agent.trim() : '';
    if (!agent) return c.json({ error: 'agent is required: the name of a kortix.yaml agent', code: 'agent_required' }, 400);
    if (isMyKortixAgentName(agent)) {
      return c.json({ error: 'My Kortix acts as the person who runs it, so it has no key of its own.', code: 'agent_not_keyable' }, 400);
    }
    const grants = await keyableAgents(c, workspaceId);
    const grant = grants.get(agent);
    if (!grant) {
      return c.json(
        { error: `No enabled agent named "${agent}" in this workspace's kortix.yaml.`, code: 'agent_not_found', agents: [...grants.keys()].sort() },
        404,
      );
    }
    agentGrant = grant;
    principalName = agent;
    serviceAccountId = await ensureAgentServiceAccount({ accountId, projectId: workspaceId, agentName: agent });
  } else {
    const ref = typeof body.bot === 'string' ? body.bot.trim() : '';
    if (!ref) return c.json({ error: 'bot is required: the name of a bot, or a new name to create one', code: 'bot_required' }, 400);
    if (ref.length > 128) return c.json({ error: 'bot name too long (max 128)' }, 400);
    let bot = await findBotServiceAccount(accountId, ref);
    if (bot && bot.status !== 'active') {
      return c.json({ error: `The bot "${bot.name}" is disabled.`, code: 'bot_disabled' }, 409);
    }
    if (!bot) {
      if (isUuid(ref)) return c.json({ error: 'bot not found', code: 'bot_not_found' }, 404);
      try {
        bot = await createServiceAccount({ accountId, name: ref, createdBy: userId, issueBearer: false });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        bot = await findBotServiceAccount(accountId, ref);
        if (!bot) throw err;
      }
      // A new bot is a member of this workspace: its key works at once, and
      // People › Roles changes the role. The route asserted `token.create`.
      await assignRole(SYSTEM_ACTOR, accountId, {
        principal: { type: 'service_account', id: bot.serviceAccountId },
        roleKey: 'member',
        scope: { type: 'project', id: workspaceId },
        source: 'manual',
        grantedBy: userId,
      });
      invalidateIamCacheForUser(bot.serviceAccountId);
      await auditIam(c, {
        accountId,
        action: 'iam.service_account.create',
        resourceType: 'service_account',
        resourceId: bot.serviceAccountId,
        after: { name: bot.name, role: 'member', workspace_id: workspaceId },
      });
    }
    serviceAccountId = bot.serviceAccountId;
    principalName = bot.name;
  }

  let created;
  try {
    created = await createAccountToken({
      accountId,
      userId: serviceAccountId,
      createdBy: userId,
      projectId: workspaceId,
      name,
      expiresAt: expiry.expiresAt,
      agentGrant,
      serviceAccountId,
      scopes,
    });
  } catch (err) {
    if (err instanceof PatPolicyError) return c.json({ error: err.message, code: err.code }, 400);
    throw err;
  }

  // A custom scope must sit inside the principal's own rights: ask the engine
  // as the new key itself, and drop the key (its secret never left) when any
  // permission is outside them.
  if (scopes && 'permissions' in scopes) {
    const keyActor = await actorForToken(serviceAccountId, accountId, created.tokenId);
    const denied: string[] = [];
    for (const permission of scopes.permissions) {
      if (!(await authorize(keyActor, permission, { type: 'workspace', id: workspaceId })).allowed) denied.push(permission);
    }
    if (denied.length > 0) {
      await deleteUnissuedAccountToken(created.tokenId, accountId);
      return c.json(
        {
          error: `The ${kind} "${principalName}" does not hold ${denied.map((p) => `"${p}"`).join(', ')} in this workspace. A key cannot hold a permission its principal lacks.`,
          code: 'key_scope_exceeds_principal',
          permissions: denied,
        },
        403,
      );
    }
  }

  const emails = await lookupEmailsByUserIds([userId]);
  return c.json(
    {
      ...tokenRow(
        { ...created, lastUsedAt: null, revokedAt: null, expiryRenewDays: null },
        { type: kind, name: principalName, service_account_id: serviceAccountId },
        userId,
        emails,
      ),
      secret_key: created.secretKey,
    },
    201,
  );
}

async function mintKey(c: Context) {
  const body = await readJsonObject(c);
  const raw = body.acts_as ?? 'me';
  if (raw !== 'me' && raw !== 'agent' && raw !== 'bot') {
    return c.json({ error: 'acts_as must be "me", "agent" or "bot"', code: 'invalid_acts_as' }, 400);
  }
  if (raw !== 'me') return mintServiceAccountKey(c, body, raw);
  // `me`: exactly the workspace-key mint of `POST …/tokens`, answered as a key row.
  const ws = await keysWorkspace(c);
  if (!ws.ok) return ws.res;
  const res = await mintTokenFromBody(c, { ...body, project_id: undefined });
  if (res.status !== 201) return res;
  const t = (await res.json()) as Record<string, unknown>;
  const userId = c.get('userId') as string;
  const emails = await lookupEmailsByUserIds([userId]);
  return c.json(
    {
      key_id: String(t.token_id),
      name: String(t.name),
      acts_as: { type: 'me', name: null, service_account_id: null },
      credential: 'token',
      public_key: String(t.public_key),
      status: String(t.status),
      expires_at: (t.expires_at as string | null) ?? null,
      last_used_at: null,
      created_at: String(t.created_at),
      revoked_at: null,
      created_by: userId,
      created_by_email: emails.get(userId) ?? null,
      scope: t.scope as 'full' | 'read' | 'custom',
      permissions: (t.permissions as string[] | null) ?? null,
      workspace_permissions: (t.workspace_permissions as string[] | null) ?? null,
      expiry_renews: t.expiry_renews === true,
      secret_key: String(t.secret_key),
    } satisfies WorkspaceKeyWire,
    201,
  );
}

/**
 * Revoke a key of the workspace. The caller's own key needs
 * `token.personal.revoke`; an agent or bot key, and an older bot's own bearer,
 * need `token.revoke`. `?delete_revoked=true` removes a revoked key of the
 * caller's own, or a disabled bot's bearer.
 */
async function revokeKey(c: Context) {
  const userId = c.get('userId') as string;
  const keyId = c.req.param('keyId') ?? '';
  if (!isUuid(keyId)) return c.json({ error: `"${keyId}" is not a valid key id (a key id is a UUID)` }, 400);
  const ws = await keysWorkspace(c);
  if (!ws.ok) return ws.res;
  const { workspaceId, accountId } = ws;
  const actor = await actorOf(c, accountId);
  const deleteRevoked = c.req.query('delete_revoked') === 'true';

  const owner = await getAccountTokenOwner(keyId, accountId);
  if (owner?.personal && owner.userId === userId && actsAsFullIdentity(c.get('authType') as string | undefined, actor)) {
    await assertAuthorized(actor, ACCOUNT_ACTIONS.TOKEN_PERSONAL_REVOKE);
    if (deleteRevoked) {
      return (await deleteRevokedPersonalAccountToken(keyId, accountId))
        ? c.json({ ok: true, deleted: true })
        : c.json({ error: 'revoked key not found' }, 404);
    }
    return (await revokeAccountToken(keyId, accountId, workspaceId))
      ? c.json({ ok: true })
      : c.json({ error: 'key not found or already revoked' }, 404);
  }

  // Anything else needs the admin leaf, so a member learns nothing about keys
  // that are not theirs (403 before 404).
  await assertAuthorized(actor, ACCOUNT_ACTIONS.TOKEN_REVOKE);
  if (await getServiceAccountKey(keyId, accountId, workspaceId)) {
    return (await revokeAccountToken(keyId, accountId, workspaceId))
      ? c.json({ ok: true })
      : c.json({ error: 'key not found or already revoked' }, 404);
  }
  const bot = await getServiceAccount(accountId, keyId);
  if (bot && bot.agentName === null && bot.bearerIssued) {
    if (deleteRevoked) {
      if (bot.status === 'active') return c.json({ error: 'Revoke the bot bearer before deleting it.', code: 'key_active' }, 409);
      await deleteServiceAccount(accountId, keyId);
      invalidateIamCacheForUser(keyId);
      return c.json({ ok: true, deleted: true });
    }
    const ok = await disableServiceAccount({ accountId, serviceAccountId: keyId, disabledBy: userId });
    if (!ok) return c.json({ error: 'key not found or already revoked' }, 404);
    invalidateIamCacheForUser(keyId);
    await auditIam(c, {
      accountId,
      action: 'iam.service_account.disable',
      resourceType: 'service_account',
      resourceId: keyId,
      before: { name: bot.name, status: bot.status },
      after: { name: bot.name, status: 'disabled' },
    });
    return c.json({ ok: true });
  }
  return c.json({ error: 'key not found' }, 404);
}

export function registerWorkspaceKeyRoutes(): void {
  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/keys',
      tags: ['accounts'],
      summary: 'List the API keys of a workspace: yours, and with token.create every agent and bot key',
      ...auth,
      request: { params: AccountIdParam },
      responses: { 200: json(KeysListSchema, 'The keys and the principals a new key can act as'), ...errors(401, 403, 404, 409) },
    }),
    ((c: AnyHandler) => listKeys(c)) as AnyHandler,
  );

  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/keys',
      tags: ['accounts'],
      summary: 'Create an API key that acts as you, an agent, or a bot (secret returned once)',
      ...auth,
      request: {
        params: AccountIdParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                name: z.string(),
                acts_as: z.enum(['me', 'agent', 'bot']).optional().openapi({
                  description:
                    '`me` (default): you, in your current role; revoked when you leave. `agent`: the agent named in `agent` (its kortix.yaml grant ∩ its role); `token.create`. `bot`: the bot named in `bot` (its roles); a new name creates the bot with the Member role; `token.create`.',
                }),
                agent: z.string().optional(),
                bot: z.string().optional(),
                scopes: z.union([z.enum(['full', 'read']), z.array(z.string())]).optional().openapi({
                  description: "`full` (default; the principal's whole rights), `read` (every `*.read` permission; GET requests only) or a list of permissions inside the principal's rights.",
                }),
                expires_at: z.string().nullable().optional().openapi({
                  description: 'ISO-8601 expiry. Omitted: 90 days (or the workspace maximum, when shorter). At most 365 days by default. `null`: no expiry, only when the workspace key policy allows it.',
                }),
              }),
            },
          },
        },
      },
      responses: { 201: json(WorkspaceKeySchema, 'The new key (secret_key returned once)'), ...errors(400, 401, 403, 404, 409) },
    }),
    ((c: AnyHandler) => mintKey(c)) as AnyHandler,
  );

  accountsRouter.openapi(
    createRoute({
      method: 'delete',
      path: '/{workspaceId}/keys/{keyId}',
      tags: ['accounts'],
      summary: 'Revoke an API key of a workspace, or delete a revoked one (delete_revoked=true)',
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string().uuid(), keyId: z.string() }),
        query: z.object({ delete_revoked: z.enum(['true', 'false']) }).partial(),
      },
      responses: {
        200: json(z.object({ ok: z.literal(true), deleted: z.boolean().optional() }), 'Revocation or deletion result'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    ((c: AnyHandler) => revokeKey(c)) as AnyHandler,
  );
}
