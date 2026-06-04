import { createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { json, errors, auth } from '../../openapi';
import { accountMembers, accounts } from '@kortix/db';
import { db } from '../../shared/db';
import {
  PatPolicyError,
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
  readBodyTokens,
  resolveAccountForUser,
  lookupEmailsByUserIds,
} from './app';

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
  let userEmail = (c.get('userEmail') as string) || '';
  // CLI PAT requests carry no email in context (the auth middleware sets it
  // empty for PATs), so resolve it from the user record — otherwise whoami
  // and friends only ever see the user id.
  if (!userEmail) {
    userEmail = (await lookupEmailsByUserIds([userId])).get(userId) || '';
  }

  let memberships: Array<{
    accountId: string;
    accountRole: string;
    name: string;
    personalAccount: boolean;
  }> = [];

  try {
    memberships = await db
      .select({
        accountId: accountMembers.accountId,
        accountRole: accountMembers.accountRole,
        name: accounts.name,
        personalAccount: accounts.personalAccount,
      })
      .from(accountMembers)
      .innerJoin(accounts, eq(accountMembers.accountId, accounts.accountId))
      .where(eq(accountMembers.userId, userId));
  } catch {
    /* table may not exist yet */
  }

  return c.json({
    user_id: userId,
    email: userEmail,
    accounts: memberships.map((m) => ({
      account_id: m.accountId,
      slug: m.accountId.slice(0, 8),
      name: accountDisplayName(m.name, userEmail, m.personalAccount),
      personal_account: m.personalAccount,
      role: m.accountRole,
    })),
  });
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
  const userId = c.get('userId') as string;
  const queryAccount = c.req.query('account_id') ?? undefined;

  let accountId: string;
  try {
    accountId = await resolveAccountForUser(userId, queryAccount);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 403);
  }

  const tokens = await listAccountTokens(accountId);
  return c.json(
    tokens.map((t) => ({
      token_id: t.tokenId,
      name: t.name,
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
  const userId = c.get('userId') as string;
  const body = await readBodyTokens(c);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return c.json({ error: 'name is required' }, 400);
  }
  if (name.length > 255) {
    return c.json({ error: 'name too long (max 255 chars)' }, 400);
  }
  const accountOverride =
    typeof body.account_id === 'string' && body.account_id.trim() ? body.account_id.trim() : undefined;

  let accountId: string;
  try {
    accountId = await resolveAccountForUser(userId, accountOverride);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 403);
  }

  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_CREATE);

  const expiresAtRaw = typeof body.expires_at === 'string' ? body.expires_at.trim() : '';
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : undefined;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    return c.json({ error: 'expires_at must be ISO-8601' }, 400);
  }

  let created;
  try {
    created = await createAccountToken({ accountId, userId, name, expiresAt });
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
  const userId = c.get('userId') as string;
  const tokenId = c.req.param('tokenId');
  const queryAccount = c.req.query('account_id') ?? undefined;

  let accountId: string;
  try {
    accountId = await resolveAccountForUser(userId, queryAccount);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 403);
  }

  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.TOKEN_REVOKE);

  const ok = await revokeAccountToken(tokenId, accountId);
  if (!ok) {
    return c.json({ error: 'token not found or already revoked' }, 404);
  }
  return c.json({ ok: true });
  },
);
}
