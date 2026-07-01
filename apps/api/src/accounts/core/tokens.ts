import { createRoute, z } from '@hono/zod-openapi';
import { Effect } from 'effect';
import { eq } from 'drizzle-orm';
import { json, errors, auth } from '../../openapi';
import { accountMembers, accounts } from '@kortix/db';
import { db } from '../../shared/db';
import { resolveAccountId } from '../../shared/resolve-account';
import {
  PatPolicyError,
  type CreateAccountTokenResult,
  createAccountToken,
  listAccountTokens,
  revokeAccountToken,
} from '../../repositories/account-tokens';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import {
  accountsRouter,
  accountDisplayName,
  AccountTokenSchema,
  OkSchema,
  MeSchema,
  autoClaimPendingInvites,
  readBodyTokens,
  resolveAccountForUser,
  lookupEmailsByUserIds,
} from './app';
import {
  accountFail,
  accountResponse,
  accountTry,
  readJsonRecord,
  runAccountWorkflow,
} from '../effect-workflows';

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
  return runAccountWorkflow(c, Effect.gen(function* () {
    const userId = c.get('userId') as string;
    const authType = (c.get('authType') as string | undefined) ?? null;
    let userEmail = (c.get('userEmail') as string) || '';
    // CLI PAT requests carry no email in context (the auth middleware sets it
    // empty for PATs), so resolve it from the user record — otherwise whoami
    // and friends only ever see the user id.
    if (!userEmail) {
      userEmail = (yield* accountTry(() => lookupEmailsByUserIds([userId]))).get(userId) || '';
    }

    const loadMemberships = () =>
      accountTry(async (): Promise<Array<{
        accountId: string;
        accountRole: string;
        name: string;
      }>> => {
        try {
          return await db
            .select({
              accountId: accountMembers.accountId,
              accountRole: accountMembers.accountRole,
              name: accounts.name,
            })
            .from(accountMembers)
            .innerJoin(accounts, eq(accountMembers.accountId, accounts.accountId))
            .where(eq(accountMembers.userId, userId));
        } catch {
          /* table may not exist yet */
          return [];
        }
      });

    if (authType === 'supabase' && userEmail) {
      yield* accountTry(() => autoClaimPendingInvites(userId, userEmail));
    }
    let memberships = yield* loadMemberships();
    if (memberships.length === 0 && authType === 'supabase') {
      yield* accountTry(() => resolveAccountId(userId));
      memberships = yield* loadMemberships();
    }

    return accountResponse({
      user_id: userId,
      email: userEmail,
      token_context: {
        auth_type: authType,
        project_id: (c.get('tokenProjectId') as string | undefined) ?? null,
        session_id: (c.get('sessionId') as string | undefined) ?? null,
        agent: (c.get('agentGrant') as { agent?: string } | null | undefined)?.agent ?? null,
        connectors: (c.get('agentGrant') as { connectors?: string[] | 'all' } | null | undefined)?.connectors ?? null,
        kortix_cli: (c.get('agentGrant') as { kortixCli?: string[] | 'all' } | null | undefined)?.kortixCli ?? null,
      },
      accounts: memberships.map((m) => ({
        account_id: m.accountId,
        slug: m.accountId.slice(0, 8),
        name: accountDisplayName(m.name, userEmail),
        role: m.accountRole,
      })),
    });
  }));
  },
);

// GET /v1/accounts/tokens — list CLI PATs for the active account
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/tokens',
    tags: ['accounts'],
    summary: 'List CLI PATs for the active account',
    ...auth,
    request: { query: z.object({ account_id: z.string() }).partial() },
    responses: {
      200: json(z.array(AccountTokenSchema), 'Personal access tokens'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  return runAccountWorkflow(c, Effect.gen(function* () {
    const userId = c.get('userId') as string;
    const queryAccount = c.req.query('account_id') ?? undefined;

    const accountId = yield* accountTry(() => resolveAccountForUser(userId, queryAccount)).pipe(
      Effect.catchAll((err) => accountFail({ error: (err.cause as Error).message }, 403)),
    );

    const tokens = yield* accountTry(() => listAccountTokens(accountId));
    return accountResponse(
      tokens.map((t) => ({
      token_id: t.tokenId,
      name: t.name,
      project_id: t.projectId ?? null,
      public_key: t.publicKey,
      status: t.status,
      expires_at: t.expiresAt?.toISOString() ?? null,
      last_used_at: t.lastUsedAt?.toISOString() ?? null,
      created_at: t.createdAt.toISOString(),
      revoked_at: t.revokedAt?.toISOString() ?? null,
      })),
    );
  }));
  },
);

// POST /v1/accounts/tokens — mint a new PAT (plaintext returned ONCE)
accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/tokens',
    tags: ['accounts'],
    summary: 'Mint a new PAT (plaintext returned once)',
    ...auth,
    request: {
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
      ...errors(400, 401, 403),
    },
  }),
  async (c: any) => {
  return runAccountWorkflow(c, Effect.gen(function* () {
    const userId = c.get('userId') as string;
    const body = yield* readJsonRecord(c);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      return yield* accountFail({ error: 'name is required' }, 400);
    }
    if (name.length > 255) {
      return yield* accountFail({ error: 'name too long (max 255 chars)' }, 400);
    }
    const accountOverride =
      typeof body.account_id === 'string' && body.account_id.trim() ? body.account_id.trim() : undefined;

    const accountId = yield* accountTry(() => resolveAccountForUser(userId, accountOverride)).pipe(
      Effect.catchAll((err) => accountFail({ error: (err.cause as Error).message }, 403)),
    );

    yield* accountTry(() => assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_CREATE));

    const expiresAtRaw = typeof body.expires_at === 'string' ? body.expires_at.trim() : '';
    const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : undefined;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return yield* accountFail({ error: 'expires_at must be ISO-8601' }, 400);
    }

    // Optional project scope. A project-scoped key only ever works on that one
    // project (the auth middleware enforces the binding); it never widens access.
    const projectId =
      typeof body.project_id === 'string' && body.project_id.trim()
        ? body.project_id.trim()
        : undefined;

    const created = yield* accountTry<CreateAccountTokenResult>(() =>
      createAccountToken({ accountId, userId, name, expiresAt, projectId }),
    ).pipe(
      Effect.catchAll((err) =>
        err.cause instanceof PatPolicyError
          ? accountFail({ error: err.cause.message, code: err.cause.code }, 400)
          : accountFail({ error: err.cause instanceof Error ? err.cause.message : String(err.cause) }, 500),
      ),
    );

    return accountResponse(
      {
      token_id: created.tokenId,
      name: created.name,
      project_id: created.projectId ?? null,
      public_key: created.publicKey,
      secret_key: created.secretKey,
      status: created.status,
      expires_at: created.expiresAt?.toISOString() ?? null,
      created_at: created.createdAt.toISOString(),
      },
      201,
    );
  }));
  },
);

// DELETE /v1/accounts/tokens/:tokenId — revoke a PAT
accountsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/tokens/{tokenId}',
    tags: ['accounts'],
    summary: 'Revoke a PAT',
    ...auth,
    request: {
      params: z.object({ tokenId: z.string() }),
      query: z.object({ account_id: z.string() }).partial(),
    },
    responses: {
      200: json(OkSchema, 'Revocation result'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  return runAccountWorkflow(c, Effect.gen(function* () {
    const userId = c.get('userId') as string;
    const tokenId = c.req.param('tokenId');
    const queryAccount = c.req.query('account_id') ?? undefined;

    const accountId = yield* accountTry(() => resolveAccountForUser(userId, queryAccount)).pipe(
      Effect.catchAll((err) => accountFail({ error: (err.cause as Error).message }, 403)),
    );

    yield* accountTry(() => assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_REVOKE));

    const ok = yield* accountTry(() => revokeAccountToken(tokenId, accountId));
    if (!ok) {
      return yield* accountFail({ error: 'token not found or already revoked' }, 404);
    }
    return accountResponse({ ok: true });
  }));
  },
);
}
