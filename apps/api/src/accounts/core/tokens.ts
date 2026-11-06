import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { userAccountNameRows } from '../../iam/membership-read';
import { accountRolesForUser } from '../../iam/read-models';
import { reportSignupWithoutWorkspace } from './signup-event';
import { isNoWorkspaceError } from '../../shared/no-workspace';
import {
  PatPolicyError,
  checkTokenMintExpiry,
  createAccountToken,
  listAccountTokens,
  listPersonalAccountTokens,
  getAccountTokenOwner,
  revokeAccountToken,
  deleteRevokedPersonalAccountToken,
} from '../../repositories/account-tokens';
import { ACCOUNT_ACTIONS, assertAuthorized, authorize } from '../../iam';
import { actorOf, type Actor } from '../../iam/actor';
import { isUuid } from '../../shared/validate';
import { loadProjectForUser } from '../../projects/lib/access';
import {
  accountsRouter,
  accountDisplayName,
  AccountIdParam,
  AccountTokenSchema,
  MeSchema,
  autoClaimPendingInvites,
  resolveAccountForUser,
  resolveAccountDisplayNames,
  lookupEmailsByUserIds,
} from './app';
import { readJsonObject } from '../../shared/http-body';
import { accountIdParam } from '../../shared/route-params';
import { workspaceIdsForAccounts } from '../../shared/resolve-account';
import type { Context } from 'hono';
import { rethrowDatabaseError } from '../../shared/database-errors';
import { resolveWorkspace, WorkspaceAmbiguousError, WORKSPACE_AMBIGUOUS_CODE } from '../../workspaces/surface';

/**
 * A query flag arrives as a string or not at all. `?mine`, `?mine=true` and
 * `?mine=1` all mean yes; anything else — including `?mine=false` — means no,
 * so a caller that spells the negative out gets the unnarrowed list rather
 * than a surprising narrowing on the truthiness of the string "false".
 */
export function isTruthyFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  return raw === '' || raw === 'true' || raw === '1';
}

/**
 * Whether the caller holds the person's full identity: a browser session, or an
 * unscoped personal access token. Only such a caller may mint or revoke a
 * personal token on the `token.personal.*` leaves. Every other credential — a
 * project-scoped PAT, an agent session, a service account, a third-party
 * `kortix_oat_` OAuth token, a sandbox API key — keeps needing the admin
 * `token.create` / `token.revoke` leaves, so it can never turn itself into a
 * wider or longer-lived bearer than the one it holds.
 */
export function actsAsFullIdentity(authType: string | undefined, actor: Actor): boolean {
  const credential = actor.credential;
  if (authType === 'supabase') return credential.kind === 'jwt';
  if (authType === 'pat') return credential.kind === 'pat' && credential.projectId === null;
  return false;
}

/** `/tokens` (the caller's default or `account_id` account) and its workspace-scoped twin. */
const TOKEN_LIST_PATHS = ['/tokens', '/{workspaceId}/tokens'] as const;

/** The account key of the workspace in the path, on the workspace-scoped token routes. */
function pathAccountOf(c: Context): string | undefined {
  return c.req.param('workspaceId') ? accountIdParam(c) : undefined;
}

/**
 * The workspace a PAT minted under a workspace path binds to. A token minted
 * under `/v1/workspaces/:workspaceId/tokens` (or its alias
 * `/v1/accounts/:workspaceId/tokens`) acts on that workspace only: on a
 * legacy account an account-wide PAT would reach every other workspace of the
 * account too. `/tokens`, the older route, has no path id and keeps minting
 * an account-wide PAT unless the body names `project_id`.
 *
 *   - a workspace id, or the account key of a 1:1 workspace → that workspace;
 *   - the account key of a legacy account → `ambiguous` (the body must name one);
 *   - a dormant account key (no project) or an unknown id → `none`.
 */
type PathTokenBinding =
  | { kind: 'none' }
  | { kind: 'workspace'; projectId: string }
  | { kind: 'ambiguous'; workspaceIds: string[] };

async function pathTokenBinding(c: Context): Promise<PathTokenBinding> {
  const raw = c.req.param('workspaceId');
  if (!raw) return { kind: 'none' };
  try {
    const workspace = await resolveWorkspace(raw);
    return workspace ? { kind: 'workspace', projectId: workspace.workspaceId } : { kind: 'none' };
  } catch (err) {
    if (err instanceof WorkspaceAmbiguousError) return { kind: 'ambiguous', workspaceIds: [...err.workspaceIds] };
    throw err;
  }
}

// Routes are registered via this function (called by the orchestrator AFTER
// middleware + mounts) so the registration order stays byte-identical to the
// original single-file router.
export function registerTokenRoutes(): void {
// GET /v1/accounts/me — identity probe for CLI + dashboard nav
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/me',
    tags: ['accounts'],
    summary: 'Identity probe for CLI + dashboard nav',
    ...auth,
    responses: {
      200: json(MeSchema, 'The authenticated user and their account memberships'),
      ...errors(401),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const authType = (c.get('authType') as string | undefined) ?? null;
  let userEmail = (c.get('userEmail') as string) || '';
  // CLI PAT requests carry no email in context (the auth middleware sets it
  // empty for PATs), so resolve it from the user record — otherwise whoami
  // and friends only ever see the user id.
  if (!userEmail) {
    userEmail = (await lookupEmailsByUserIds([userId])).get(userId) || '';
  }

  const loadMemberships = async (): Promise<Array<{
    accountId: string;
    accountRole: string;
    name: string;
  }>> => {
    try {
      // `account_members` says WHICH accounts; `role_assignments` says at what
      // role — the same split GET /accounts uses.
      const [rows, rolesByAccount] = await Promise.all([
        userAccountNameRows(userId),
        accountRolesForUser(userId),
      ]);
      return rows.map((r) => ({ ...r, accountRole: rolesByAccount.get(r.accountId) ?? 'member' }));
    } catch {
      /* table may not exist yet */
      return [];
    }
  };

  // No account is created here (Workspaces D3, 2026-11-05): a person with
  // no membership gets `accounts: []`. The pre-claim read decides only
  // whether to report the `user_signed_up` event.
  let memberships = await loadMemberships();
  if (memberships.length === 0 && authType === 'supabase') {
    reportSignupWithoutWorkspace(userId);
  }
  if (authType === 'supabase' && userEmail) {
    await autoClaimPendingInvites(userId, userEmail);
    memberships = await loadMemberships();
  }

  const displayNames = await resolveAccountDisplayNames(memberships, {
    userId,
    email: userEmail,
  });
  const workspaceIds = await workspaceIdsForAccounts(memberships.map((m) => m.accountId));

  return c.json({
    user_id: userId,
    email: userEmail,
    token_context: {
      auth_type: authType,
      // The account token this request authenticated with (null for a web
      // session), so a client can tell its own credential from the rest:
      // `kortix tokens rm` refuses to revoke it by accident (KRTX-1842).
      token_id: (c.get('iamTokenBinding') as { tokenId?: string } | undefined)?.tokenId ?? null,
      project_id: (c.get('tokenProjectId') as string | undefined) ?? null,
      workspace_id: (c.get('tokenProjectId') as string | undefined) ?? null,
      session_id: (c.get('sessionId') as string | undefined) ?? null,
      agent: (c.get('agentGrant') as { agent?: string } | null | undefined)?.agent ?? null,
      connectors: (c.get('agentGrant') as { connectors?: string[] | 'all' } | null | undefined)?.connectors ?? null,
      kortix_permissions: (c.get('agentGrant') as { permissions?: string[] | 'all' } | null | undefined)?.permissions ?? null,
      // Deprecated wire alias of `kortix_permissions` — CLIs released before
      // the 2026-09-22 rename read this key.
      kortix_cli: (c.get('agentGrant') as { permissions?: string[] | 'all' } | null | undefined)?.permissions ?? null,
      env: (c.get('agentGrant') as { env?: string[] | 'all' } | null | undefined)?.env ?? null,
    },
    accounts: memberships.map((m) => ({
      account_id: m.accountId,
      workspace_id: workspaceIds.get(m.accountId) ?? null,
      slug: m.accountId.slice(0, 8),
      name: displayNames.get(m.accountId) ?? accountDisplayName(m.name, userEmail),
      role: m.accountRole,
    })),
  });
  },
);

// GET /v1/accounts/tokens — list CLI PATs for the active account
// GET /v1/workspaces/:workspaceId/tokens — the same list, for the workspace in the path
for (const path of TOKEN_LIST_PATHS) {
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path,
    tags: ['accounts'],
    summary: path === '/tokens' ? 'List CLI PATs for the active account' : 'List CLI PATs of a workspace',
    ...auth,
    request: {
      ...(path === '/tokens' ? {} : { params: AccountIdParam }),
      query: z
        .object({
          account_id: z.string(),
          // `mine=true` narrows the list to the CALLER'S OWN hand-minted API
          // keys — no other member's keys, no session connector tokens, no
          // service-account bearers. That is what a person's own settings page
          // shows (`/settings/tokens`); the account hub's Tokens tab is the
          // automation surface and reads service accounts instead. Without
          // it a caller with `token.revoke` gets every live token of the
          // account; any other caller gets only the live tokens they own.
          mine: z.string(),
        })
        .partial(),
    },
    responses: {
      200: json(z.array(AccountTokenSchema), 'Personal access tokens'),
      ...errors(401, 403, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const queryAccount = pathAccountOf(c) ?? c.req.query('account_id') ?? undefined;

  let accountId: string;
  try {
    accountId = await resolveAccountForUser(userId, queryAccount);
  } catch (err) {
    rethrowDatabaseError(err);
    // 409 `no_workspace`: a person with no account has nowhere to mint into.
    if (isNoWorkspaceError(err)) throw err;
    return c.json({ error: (err as Error).message }, 403);
  }

  const actor = await actorOf(c, accountId);
  await assertAuthorized(actor, ACCOUNT_ACTIONS.TOKEN_READ);

  // The account-wide list names every member's keys. Only a caller who may
  // revoke them (token.revoke) reads it; anyone else gets the live tokens
  // they own (their keys and their sessions' tokens).
  const canSeeAll = (await authorize(actor, ACCOUNT_ACTIONS.TOKEN_REVOKE)).allowed;
  const tokens = isTruthyFlag(c.req.query('mine'))
    ? await listPersonalAccountTokens(accountId, userId)
    : await listAccountTokens(accountId, undefined, canSeeAll ? undefined : userId);
  return c.json(
    tokens.map((t) => ({
      token_id: t.tokenId,
      name: t.name,
      project_id: t.projectId ?? null,
      workspace_id: t.projectId ?? null,
      public_key: t.publicKey,
      status: t.status,
      expires_at: t.expiresAt?.toISOString() ?? null,
      last_used_at: t.lastUsedAt?.toISOString() ?? null,
      created_at: t.createdAt.toISOString(),
      revoked_at: t.revokedAt?.toISOString() ?? null,
    })),
  );
  },
);
}

// POST /v1/accounts/tokens — mint a new PAT (plaintext returned ONCE)
// POST /v1/workspaces/:workspaceId/tokens — mint into the workspace in the path
for (const path of TOKEN_LIST_PATHS) {
accountsRouter.openapi(
  createRoute({
    method: 'post',
    path,
    tags: ['accounts'],
    summary: 'Mint a new PAT (plaintext returned once)',
    ...auth,
    request: {
      ...(path === '/tokens' ? {} : { params: AccountIdParam }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              name: z.string(),
              account_id: z.string().optional(),
              expires_at: z.string().optional(),
              project_id: z.string().uuid().optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: json(AccountTokenSchema, 'The newly minted token (secret_key returned once)'),
      ...errors(400, 401, 403, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  // A connected app's revocable `kortix_oat_` token must not mint a durable one.
  if (c.get('authType') === 'oauth') {
    return c.json({ error: 'Connected apps cannot mint personal access tokens.' }, 403);
  }
  const body = await readJsonObject(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }
  if (name.length > 255) {
    return c.json({ error: 'name too long (max 255 chars)' }, 400);
  }
  const accountOverride =
    pathAccountOf(c) ??
    (typeof body.account_id === 'string' && body.account_id.trim() ? body.account_id.trim() : undefined);

  let accountId: string;
  try {
    accountId = await resolveAccountForUser(userId, accountOverride);
  } catch (err) {
    rethrowDatabaseError(err);
    // 409 `no_workspace`: a person with no account has nowhere to mint into.
    if (isNoWorkspaceError(err)) throw err;
    return c.json({ error: (err as Error).message }, 403);
  }

  // A PAT authenticates AS the person who minted it and is authorized against
  // that person's own roles, so minting your own is a membership right
  // (`token.personal.create`, held by every system account role) — without it
  // a plain member cannot run `kortix login` at all.
  const actor = await actorOf(c, accountId);
  await assertAuthorized(
    actor,
    actsAsFullIdentity(c.get('authType') as string | undefined, actor)
      ? ACCOUNT_ACTIONS.TOKEN_PERSONAL_CREATE
      : ACCOUNT_ACTIONS.TOKEN_CREATE,
  );

  const expiresAtRaw = typeof body.expires_at === 'string' ? body.expires_at.trim() : '';
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : undefined;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return c.json({ error: 'expires_at must be ISO-8601' }, 400);
  }
  const expiryRefusal = await checkTokenMintExpiry(
    expiresAt,
    c.get('tokenProjectId') ? (c.get('iamTokenId') as string | undefined) : undefined,
  );
  if (expiryRefusal) {
    return c.json({ error: expiryRefusal.error, code: expiryRefusal.code }, expiryRefusal.status);
  }

  // Optional project scope. A project-scoped key only ever works on that one
  // project (the auth middleware enforces the binding); it never widens access.
  let projectId =
    typeof body.project_id === 'string' && body.project_id.trim()
      ? body.project_id.trim()
      : undefined;

  const binding = await pathTokenBinding(c);
  if (binding.kind === 'workspace') {
    if (projectId && projectId !== binding.projectId) {
      return c.json({ error: 'project_id names another workspace than the one in the path' }, 400);
    }
    projectId = binding.projectId;
  } else if (binding.kind === 'ambiguous' && !projectId) {
    return c.json(
      {
        error: 'This account holds several workspaces. Name one: mint under /v1/workspaces/<workspace id>/tokens, or pass project_id.',
        code: WORKSPACE_AMBIGUOUS_CODE,
        workspace_ids: binding.workspaceIds,
      },
      409,
    );
  }

  if (projectId) {
    const loaded = await loadProjectForUser(c, projectId, 'credentials');
    if (!loaded?.row || loaded.row.accountId !== accountId) {
      return c.json({ error: 'Project not found in account' }, 403);
    }
  }

  let created;
  try {
    created = await createAccountToken({ accountId, userId, name, expiresAt, projectId });
  } catch (err) {
    if (err instanceof PatPolicyError) {
      return c.json({ error: err.message, code: err.code }, 400);
    }
    throw err;
  }
  return c.json(
    {
      token_id: created.tokenId,
      name: created.name,
      project_id: created.projectId ?? null,
      workspace_id: created.projectId ?? null,
      public_key: created.publicKey,
      secret_key: created.secretKey,
      status: created.status,
      expires_at: created.expiresAt?.toISOString() ?? null,
      created_at: created.createdAt.toISOString(),
    },
    201,
  );
  },
);
}

// DELETE /v1/accounts/tokens/:tokenId — revoke a PAT
// DELETE /v1/workspaces/:workspaceId/tokens/:tokenId — the same, in the workspace in the path
for (const path of ['/tokens/{tokenId}', '/{workspaceId}/tokens/{tokenId}'] as const) {
accountsRouter.openapi(
  createRoute({
    method: 'delete',
    path,
    tags: ['accounts'],
    summary: 'Revoke a PAT, or explicitly delete a revoked personal key',
    ...auth,
    request: {
      params:
        path === '/tokens/{tokenId}'
          ? z.object({ tokenId: z.string() })
          : z.object({ workspaceId: z.string().uuid(), tokenId: z.string() }),
      query: z.object({ account_id: z.string(), delete_revoked: z.enum(['true', 'false']) }).partial(),
    },
    responses: {
      200: json(z.object({ ok: z.literal(true), deleted: z.boolean().optional() }), 'Revocation or deletion result'),
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const tokenId = c.req.param('tokenId');
  // A non-UUID id would reach the uuid-typed `account_tokens.token_id` query
  // and surface as a 500 `22P02` (shared/validate.ts). A client-input error is
  // answered as one, before any account or token lookup runs.
  if (!isUuid(tokenId)) {
    return c.json({ error: `"${tokenId}" is not a valid token id (a token id is a UUID)` }, 400);
  }
  const queryAccount = pathAccountOf(c) ?? c.req.query('account_id') ?? undefined;

  let accountId: string;
  try {
    accountId = await resolveAccountForUser(userId, queryAccount);
  } catch (err) {
    rethrowDatabaseError(err);
    // 409 `no_workspace`: a person with no account has nowhere to mint into.
    if (isNoWorkspaceError(err)) throw err;
    return c.json({ error: (err as Error).message }, 403);
  }

  // Your own hand-minted token needs only `token.personal.revoke`. Anything
  // else — another person's token, a session or service-account bearer, or an
  // id that does not exist — needs the admin `token.revoke`, so a member learns
  // nothing about tokens that are not theirs (403, not 404).
  const actor = await actorOf(c, accountId);
  const owner = await getAccountTokenOwner(tokenId, accountId);
  const ownPersonalToken =
    actsAsFullIdentity(c.get('authType') as string | undefined, actor) &&
    owner?.personal === true &&
    owner.userId === userId;
  await assertAuthorized(
    actor,
    ownPersonalToken ? ACCOUNT_ACTIONS.TOKEN_PERSONAL_REVOKE : ACCOUNT_ACTIONS.TOKEN_REVOKE,
  );

  if (c.req.query('delete_revoked') === 'true') {
    const deleted = await deleteRevokedPersonalAccountToken(tokenId, accountId);
    if (deleted) return c.json({ ok: true, deleted: true });
    return c.json({ error: 'revoked personal token not found' }, 404);
  }

  const ok = await revokeAccountToken(tokenId, accountId);
  if (!ok) {
    return c.json({ error: 'token not found or already revoked' }, 404);
  }
  return c.json({ ok: true });
  },
);
}
}
