import { createRoute, z } from '@hono/zod-openapi';
import { json, errors, auth } from '../../openapi';
import { userAccountNameRows } from '../../iam/membership-read';
import { accountRolesForUser } from '../../iam/read-models';
import { reportSignupWithoutWorkspace } from './signup-event';
import { isNoWorkspaceError } from '../../shared/no-workspace';
import {
  PatPolicyError,
  checkTokenMintExpiry,
  resolveMintExpiry,
  clampDefaultToParentExpiry,
  createAccountToken,
  listAccountTokens,
  listPersonalAccountTokens,
  getAccountTokenOwner,
  revokeAccountToken,
  deleteRevokedPersonalAccountToken,
  listPersonalTokensOfUser,
  personalTokenAccountOfUser,
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
import { keyScopeWire, keyScopeWithin, parseKeyScopesInput, type KeyScopes } from '../../iam/key-scope';
import type { TokenBinding } from '../../iam/actor';

/** The scope and expiry fields every key row carries on the wire. */
export function keyWire(t: { scopes?: KeyScopes | null; expiryRenewDays?: number | null }) {
  return { ...keyScopeWire(t.scopes ?? null), expiry_renews: t.expiryRenewDays != null };
}

/** The scope of the key this request authenticated with (null = full, or no key). */
function callerKeyScopes(c: Context): KeyScopes | null {
  return (c.get('iamTokenBinding') as TokenBinding | undefined)?.scopes ?? null;
}

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

/** A browser session, or a personal key bound to no workspace and no session. */
export function isPersonCaller(c: Context): boolean {
  const authType = c.get('authType') as string | undefined;
  if (authType === 'supabase') return true;
  return authType === 'pat' && !c.get('tokenProjectId') && !c.get('sessionId') && !c.get('agentGrant');
}

/** `/tokens` (the caller's default or `account_id` account) and its workspace-scoped twin. */
const TOKEN_LIST_PATHS = ['/tokens', '/{workspaceId}/tokens'] as const;

/** The account key of the workspace in the path, on the workspace-scoped token routes. */
export function pathAccountOf(c: Context): string | undefined {
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
  | { kind: 'ambiguous' };

export async function pathTokenBinding(c: Context): Promise<PathTokenBinding> {
  const raw = c.req.param('workspaceId');
  if (!raw) return { kind: 'none' };
  try {
    const workspace = await resolveWorkspace(raw);
    return workspace ? { kind: 'workspace', projectId: workspace.workspaceId } : { kind: 'none' };
  } catch (err) {
    if (err instanceof WorkspaceAmbiguousError) return { kind: 'ambiguous' };
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

// GET /v1/me/tokens — the person's personal keys, across every workspace
// DELETE /v1/me/tokens/:tokenId — revoke one (or delete a revoked one)
// A personal key is the person's own credential: listing and revoking it needs
// no workspace grant, and works for a key minted in a workspace they left.
// Only the person: a browser session or an unbound personal key. A workspace
// key is refused by the credential fence (person-route) before this runs.
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/me/tokens',
    tags: ['accounts'],
    summary: 'List your personal keys',
    ...auth,
    responses: {
      200: json(z.array(AccountTokenSchema), 'Your personal keys (bound to no workspace)'),
      ...errors(401, 403),
    },
  }),
  async (c) => {
  if (!isPersonCaller(c)) return c.json({ error: 'Personal keys are managed by the person, from a browser session or a personal key', code: 'person_route' }, 403);
  const tokens = await listPersonalTokensOfUser(c.get('userId') as string);
  return c.json(
    tokens.map((t) => ({
      token_id: t.tokenId,
      name: t.name,
      project_id: null,
      workspace_id: null,
      public_key: t.publicKey,
      status: t.status,
      expires_at: t.expiresAt?.toISOString() ?? null,
      last_used_at: t.lastUsedAt?.toISOString() ?? null,
      created_at: t.createdAt.toISOString(),
      revoked_at: t.revokedAt?.toISOString() ?? null,
      ...keyWire(t),
    })),
  );
  },
);

accountsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/me/tokens/{tokenId}',
    tags: ['accounts'],
    summary: 'Revoke one of your personal keys, or delete a revoked one',
    ...auth,
    request: {
      params: z.object({ tokenId: z.string() }),
      query: z.object({ delete_revoked: z.enum(['true', 'false']) }).partial(),
    },
    responses: {
      200: json(z.object({ ok: z.literal(true), deleted: z.boolean().optional() }), 'Revocation or deletion result'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c) => {
  const tokenId = c.req.param('tokenId');
  if (!isUuid(tokenId)) return c.json({ error: `"${tokenId}" is not a valid token id (a token id is a UUID)` }, 400);
  if (!isPersonCaller(c)) return c.json({ error: 'Personal keys are managed by the person, from a browser session or a personal key', code: 'person_route' }, 403);
  // Another person's key and an unknown id answer the same 404.
  const accountId = await personalTokenAccountOfUser(tokenId, c.get('userId') as string);
  if (!accountId) return c.json({ error: 'token not found' }, 404);
  if (c.req.query('delete_revoked') === 'true') {
    if (!(await deleteRevokedPersonalAccountToken(tokenId, accountId))) {
      return c.json({ error: 'revoked personal token not found' }, 404);
    }
    return c.json({ ok: true as const, deleted: true }, 200);
  }
  if (!(await revokeAccountToken(tokenId, accountId))) return c.json({ error: 'token not found or already revoked' }, 404);
  return c.json({ ok: true as const }, 200);
  },
);

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
  // A service account lists no person's keys: refused as a non-member (403),
  // before the account lookup, which would answer it 409 no_workspace.
  if (c.get('authType') === 'service_account') {
    return c.json({ error: 'A service account cannot list access tokens', code: 'not_a_member' }, 403);
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
      ...keyWire(t),
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
    summary: path === '/tokens' ? 'Mint a key (deprecated: mint workspace keys under /v1/workspaces/{workspaceId}/tokens)' : 'Mint a workspace key (plaintext returned once)',
    ...(path === '/tokens'
      ? {
          deprecated: true,
          description:
            'Kept for CLIs released before workspace keys. Without `project_id` it mints a personal key that acts as you in every workspace. New clients mint workspace keys with `POST /v1/workspaces/{workspaceId}/tokens`.',
        }
      : {}),
    ...auth,
    request: {
      ...(path === '/tokens' ? {} : { params: AccountIdParam }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              name: z.string(),
              account_id: z.string().optional(),
              expires_at: z.string().nullable().optional().openapi({
                description:
                  'ISO-8601 expiry. Omitted: 90 days (or the workspace maximum, when shorter). At most the workspace maximum, 365 days by default. `null`: no expiry, only when the workspace key policy allows it (`allow_no_expiry`).',
              }),
              project_id: z.string().uuid().optional(),
              renews: z.boolean().optional().openapi({
                description:
                  'A renewing expiry for a personal key minted from a browser session (the CLI login): each use moves `expires_at` out again by the default lifetime. Ignored for any other caller.',
              }),
              scopes: z
                .union([z.enum(['full', 'read']), z.array(z.string())])
                .optional()
                .openapi({
                  description:
                    "What the key may do inside its creator's role: `full` (default; the whole role), `read` (every `*.read` permission; GET requests only) or a list of permissions in either spelling. A workspace key only. Checked against the creator's current role on every request. A scoped key mints only keys inside its own scope.",
                }),
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
  (async (c: any) => mintTokenFromBody(c, await readJsonObject(c))) as any,
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

/**
 * Mint a key that acts as the caller, from a parsed body: the handler of
 * `POST /v1/accounts/tokens` and `POST /v1/workspaces/:workspaceId/tokens`, and
 * the `acts_as: "me"` branch of `POST /v1/workspaces/:workspaceId/keys`.
 */
export async function mintTokenFromBody(c: Context, body: Record<string, unknown>): Promise<Response> {
  const userId = c.get('userId') as string;
  // A connected app's revocable `kortix_oat_` token must not mint a durable one.
  if (c.get('authType') === 'oauth') {
    return c.json({ error: 'Connected apps cannot mint personal access tokens.' }, 403);
  }
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

  // Default 90 days, at most the workspace maximum (365 days by default); no
  // expiry only when the key policy allows it (resolveMintExpiry).
  const expiry = await resolveMintExpiry(accountId, Object.hasOwn(body, 'expires_at') ? body.expires_at : undefined);
  if (!expiry.ok) return c.json({ error: expiry.error, code: expiry.code }, expiry.status);
  const parentTokenId = c.get('tokenProjectId') ? (c.get('iamTokenId') as string | undefined) : undefined;
  const expiresAt = Object.hasOwn(body, 'expires_at')
    ? expiry.expiresAt
    : await clampDefaultToParentExpiry(expiry.expiresAt, parentTokenId);
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
        // No id list: a member of a legacy account must not learn the ids of
        // workspaces they cannot read (finding 34). GET /v1/workspaces lists
        // the ones they can.
        code: WORKSPACE_AMBIGUOUS_CODE,
      },
      409,
    );
  }

  if (projectId) {
    // The person minting their own key needs only to open the workspace: the
    // key acts as them there, never wider than a personal key (which every
    // member mints with `token.personal.create`). Any other caller (a key
    // minting a key) keeps the credential leaf, `project.credentials.issue`.
    const fullIdentity = actsAsFullIdentity(c.get('authType') as string | undefined, actor);
    const loaded = await loadProjectForUser(c, projectId, fullIdentity ? 'read' : 'credentials');
    if (!loaded?.row || loaded.row.accountId !== accountId) {
      return c.json({ error: 'Workspace not found' }, 403);
    }
  }

  // The key's scope (design.md §3.2 C4a). Omitted: full, or the minting key's
  // own scope, so a scoped key never mints a wider one.
  const parsedScopes = parseKeyScopesInput(body.scopes);
  if (!parsedScopes.ok) return c.json({ error: parsedScopes.error, code: parsedScopes.code }, 400);
  const parentScopes = callerKeyScopes(c);
  const scopes = parsedScopes.explicit ? parsedScopes.scopes : parentScopes;
  if (scopes && !projectId) {
    return c.json(
      { error: 'A scoped key is a workspace key: mint it under /v1/workspaces/<workspace id>/tokens.', code: 'invalid_scopes' },
      400,
    );
  }
  if (!keyScopeWithin(scopes, parentScopes)) {
    return c.json({ error: 'A scoped key can only mint keys inside its own scope.', code: 'key_scope_exceeds_parent' }, 403);
  }
  if (scopes && 'permissions' in scopes && projectId) {
    // Every listed permission must be one the creator holds NOW in this
    // workspace. The scope only narrows; this refuses a list that names
    // permissions the key could never use, so the key reads as what it does.
    const denied: string[] = [];
    for (const permission of scopes.permissions) {
      if (!(await authorize(actor, permission, { type: 'workspace', id: projectId })).allowed) denied.push(permission);
    }
    if (denied.length > 0) {
      return c.json(
        {
          error: `Your role in this workspace does not include ${denied.map((p) => `"${p}"`).join(', ')}. A key cannot hold a permission its creator lacks.`,
          code: 'key_scope_exceeds_role',
          permissions: denied,
        },
        403,
      );
    }
  }

  // The CLI browser login: a personal key from a browser session renews on use,
  // as the device login does (cli/device-grants.ts).
  const renews = body.renews === true && c.get('authType') === 'supabase' && !projectId && expiresAt !== undefined;
  const expiryRenewDays = renews ? Math.max(1, Math.round((expiresAt!.getTime() - Date.now()) / 86_400_000)) : null;

  let created;
  try {
    created = await createAccountToken({ accountId, userId, name, expiresAt, projectId, scopes, expiryRenewDays });
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
      ...keyWire({ scopes: created.scopes, expiryRenewDays }),
    },
    201,
  );
}
