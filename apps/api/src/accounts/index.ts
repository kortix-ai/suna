import { Context } from 'hono';
import { createRoute, z } from '@hono/zod-openapi';
import { and, count, eq, gt, isNull, sql } from 'drizzle-orm';
import { makeOpenApiApp, json, errors, auth, ErrorSchema } from '../openapi';
import { accountGroupMembers, accountGroups, accountInvitations, accountMembers, accounts, accountUser, projectMembers, projects } from '@kortix/db';
import type { AppEnv } from '../types';
import { db } from '../shared/db';
import { supabaseAuth } from '../middleware/auth';
import { getSupabase } from '../shared/supabase';
import { lookupUserIdByEmail } from '../shared/users';
import { resolveAccountId } from '../shared/resolve-account';
import {
  PatPolicyError,
  createAccountToken,
  listAccountTokens,
  revokeAccountToken,
} from '../repositories/account-tokens';
import { sendAccountInviteEmail, buildInviteUrl } from './email';
import { authorize, ACCOUNT_ACTIONS, assertAuthorized } from '../iam';
import { onMemberAdded, onMemberRemoved } from '../billing/services/seat-management';

function defaultAccountName(email: string | null | undefined): string {
  const normalized = email?.trim();
  return normalized ? `${normalized}'s Account` : 'Account';
}

function accountDisplayName(
  name: string | null | undefined,
  email: string | null | undefined,
  personalAccount: boolean,
): string {
  const normalized = name?.trim();
  if (personalAccount && (!normalized || normalized === 'Personal' || normalized === 'User')) {
    return defaultAccountName(email);
  }
  return normalized || defaultAccountName(email);
}

import { iamRouter } from './iam';
import { auditRouter } from './audit';
import { accountSessionGate } from '../iam/session-gate';

export const accountsRouter = makeOpenApiApp<AppEnv>();

// ─── Shared response/request schemas (power the Scalar docs) ────────────────

const AccountSummarySchema = z
  .object({
    account_id: z.string(),
    name: z.string(),
    slug: z.string(),
    personal_account: z.boolean(),
    created_at: z.string(),
    updated_at: z.string(),
    account_role: z.string().optional(),
    is_primary_owner: z.boolean().optional(),
  })
  .openapi('AccountSummary');

const AccountDetailSchema = z
  .object({
    account_id: z.string(),
    name: z.string(),
    personal_account: z.boolean(),
    member_count: z.number(),
    project_count: z.number(),
    role: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('AccountDetail');

const AccountMemberSchema = z
  .object({
    user_id: z.string(),
    email: z.string().nullable(),
    account_role: z.string(),
    is_super_admin: z.boolean(),
    explicit_project_count: z.number(),
    groups: z.array(z.object({ group_id: z.string(), name: z.string() })),
    active_pat_count: z.number(),
    has_verified_mfa: z.boolean(),
    joined_at: z.string(),
  })
  .openapi('AccountMember');

const AccountTokenSchema = z
  .object({
    token_id: z.string(),
    name: z.string(),
    public_key: z.string(),
    status: z.string(),
    expires_at: z.string().nullable(),
    last_used_at: z.string().nullable().optional(),
    created_at: z.string(),
    revoked_at: z.string().nullable().optional(),
    secret_key: z.string().optional(),
  })
  .openapi('AccountToken');

const AccountInviteSchema = z
  .object({
    invite_id: z.string(),
    email: z.string(),
    initial_role: z.string(),
    invited_by: z.string().nullable(),
    created_at: z.string(),
    expires_at: z.string(),
    invite_url: z.string(),
  })
  .openapi('AccountInvite');

const OkSchema = z.object({ ok: z.boolean() }).openapi('OkResponse');

const MeSchema = z
  .object({
    user_id: z.string(),
    email: z.string(),
    accounts: z.array(
      z.object({
        account_id: z.string(),
        slug: z.string(),
        name: z.string(),
        personal_account: z.boolean(),
        role: z.string(),
      }),
    ),
  })
  .openapi('AccountMe');

const AccountIdParam = z.object({ accountId: z.string() });

accountsRouter.use('/*', supabaseAuth);
// Enforce per-account session policies (max lifetime / idle timeout /
// force-logout) on every authenticated, account-scoped request. No-op
// on routes without an :accountId param.
accountsRouter.use('/*', accountSessionGate());

// Mount IAM routes (groups/policies/roles/super-admin/effective). Sub-router
// declares its own paths under /:accountId/iam/*, so mounting at '/' here is
// correct.
accountsRouter.route('/', iamRouter);
accountsRouter.route('/', auditRouter);

// ─── Static (non-parameterized) routes MUST come before /:accountId ────────
// Hono matches routes in registration order, so anything declared after the
// `:accountId` handler at line ~290 would be shadowed by it.

async function readBodyTokens(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

async function resolveAccountForUser(
  userId: string,
  override: string | undefined,
): Promise<string> {
  if (override) {
    const [membership] = await db
      .select({ accountId: accountMembers.accountId })
      .from(accountMembers)
      .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, override)))
      .limit(1);
    if (!membership) {
      throw new Error('not a member of the requested account');
    }
    return membership.accountId;
  }
  return resolveAccountId(userId);
}

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

type AccountRole = 'owner' | 'admin' | 'member';

async function readBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return (await c.req.json()) ?? {};
  } catch {
    return {};
  }
}

function normalizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeEmail(value: unknown): string | null {
  const raw = normalizeString(value);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (!lower.includes('@')) return null;
  return lower;
}

function parseRole(value: unknown, allowed: AccountRole[]): AccountRole | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  return (allowed as string[]).includes(v) ? (v as AccountRole) : null;
}

async function getMembership(userId: string, accountId: string) {
  const [row] = await db
    .select({ accountRole: accountMembers.accountRole })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

async function countOwners(accountId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.accountRole, 'owner')));
  return Number(row?.n ?? 0);
}


async function lookupEmailsByUserIds(userIds: string[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  if (userIds.length === 0) return result;
  const supabase = getSupabase();
  await Promise.all(
    userIds.map(async (uid) => {
      try {
        const { data } = await supabase.auth.admin.getUserById(uid);
        result.set(uid, data?.user?.email ?? null);
      } catch {
        result.set(uid, null);
      }
    }),
  );
  return result;
}

function serializeAccount(row: typeof accounts.$inferSelect) {
  return {
    account_id: row.accountId,
    name: row.name,
    slug: row.accountId.slice(0, 8),
    personal_account: row.personalAccount,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

// Auto-claim any pending invitations matching the caller's email. Each invite
// becomes an account_members row (skipped on duplicate) and its accepted_at is
// stamped so subsequent calls are no-ops. Errors are swallowed — auto-claim is
// best-effort and must never block account listing.
async function autoClaimPendingInvites(userId: string, email: string): Promise<void> {
  if (!email) return;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;

  try {
    const pending = await db
      .select()
      .from(accountInvitations)
      .where(
        and(
          sql`lower(${accountInvitations.email}) = ${normalized}`,
          isNull(accountInvitations.acceptedAt),
          gt(accountInvitations.expiresAt, new Date()),
        ),
      );

    for (const invite of pending) {
      try {
        await db
          .insert(accountMembers)
          .values({
            userId,
            accountId: invite.accountId,
            accountRole: invite.initialRole,
          })
          .onConflictDoNothing({
            target: [accountMembers.userId, accountMembers.accountId],
          });
        await db
          .update(accountInvitations)
          .set({ acceptedAt: new Date() })
          .where(eq(accountInvitations.inviteId, invite.inviteId));
      } catch {
        // Skip individual invite failures; keep processing the rest.
      }
    }
  } catch {
    // Table may not exist yet — fall through.
  }
}

// GET /v1/accounts — list user's accounts.
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/',
    tags: ['accounts'],
    summary: "List the user's accounts",
    ...auth,
    responses: {
      200: json(z.array(AccountSummarySchema), 'Accounts the user belongs to'),
      ...errors(401),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const userEmail = c.get('userEmail') as string;

  await autoClaimPendingInvites(userId, userEmail);

  try {
    const memberships = await db
      .select({
        accountId: accountMembers.accountId,
        accountRole: accountMembers.accountRole,
        name: accounts.name,
        personalAccount: accounts.personalAccount,
        createdAt: accounts.createdAt,
        updatedAt: accounts.updatedAt,
      })
      .from(accountMembers)
      .innerJoin(accounts, eq(accountMembers.accountId, accounts.accountId))
      .where(eq(accountMembers.userId, userId));

    if (memberships.length > 0) {
      return c.json(
        memberships.map((m) => ({
          account_id: m.accountId,
          name: accountDisplayName(m.name, userEmail, m.personalAccount),
          slug: m.accountId.slice(0, 8),
          personal_account: m.personalAccount,
          created_at: m.createdAt?.toISOString() ?? new Date().toISOString(),
          updated_at: m.updatedAt?.toISOString() ?? new Date().toISOString(),
          account_role: m.accountRole || 'owner',
          is_primary_owner: m.accountRole === 'owner',
        })),
      );
    }
  } catch {
    // table doesn't exist yet — fall through to legacy basejump
  }

  try {
    const legacyMemberships = await db
      .select({
        accountId: accountUser.accountId,
        accountRole: accountUser.accountRole,
      })
      .from(accountUser)
      .where(eq(accountUser.userId, userId));

    if (legacyMemberships.length > 0) {
      return c.json(
        legacyMemberships.map((m) => ({
          account_id: m.accountId,
          name: defaultAccountName(userEmail),
          slug: m.accountId.slice(0, 8),
          personal_account: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          account_role: m.accountRole || 'owner',
          is_primary_owner: m.accountRole === 'owner',
        })),
      );
    }
  } catch {
    // basejump doesn't exist
  }

  try {
    const personalName = defaultAccountName(userEmail);
    const [created] = await db
      .insert(accounts)
      .values({ name: personalName, personalAccount: true })
      .returning();
    await db.insert(accountMembers).values({
      userId,
      accountId: created.accountId,
      accountRole: 'owner',
      isSuperAdmin: true,
    });
    return c.json([
      {
        account_id: created.accountId,
        name: created.name,
        slug: created.accountId.slice(0, 8),
        personal_account: true,
        created_at: created.createdAt.toISOString(),
        updated_at: created.updatedAt.toISOString(),
        account_role: 'owner',
        is_primary_owner: true,
      },
    ]);
  } catch {
    return c.json([
      {
        account_id: userId,
        name: defaultAccountName(userEmail),
        slug: userId.slice(0, 8),
        personal_account: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        account_role: 'owner',
        is_primary_owner: true,
      },
    ]);
  }
  },
);

// POST /v1/accounts — create a new team account.
accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/',
    tags: ['accounts'],
    summary: 'Create a new team account',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: z.object({ name: z.string() }) } } },
    },
    responses: {
      201: json(AccountSummarySchema, 'The newly created account'),
      ...errors(400, 401),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const body = await readBody(c);
  const name = normalizeString(body.name);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 255) return c.json({ error: 'name is too long' }, 400);

  const [account] = await db
    .insert(accounts)
    .values({ name, personalAccount: false })
    .returning();

  await db.insert(accountMembers).values({
    userId,
    accountId: account.accountId,
    accountRole: 'owner',
    isSuperAdmin: true,
  });

  return c.json(
    {
      account_id: account.accountId,
      name: account.name,
      slug: account.accountId.slice(0, 8),
      personal_account: account.personalAccount,
      created_at: account.createdAt.toISOString(),
      updated_at: account.updatedAt.toISOString(),
      account_role: 'owner',
      is_primary_owner: true,
    },
    201,
  );
  },
);

// GET /v1/accounts/:accountId — details.
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}',
    tags: ['accounts'],
    summary: 'Get account details',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(AccountDetailSchema, 'Account details'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const [row] = await db
    .select()
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!row) return c.json({ error: 'Not found' }, 404);

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);

  const [memberCountRow] = await db
    .select({ n: count() })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));
  const [projectCountRow] = await db
    .select({ n: count() })
    .from(projects)
    .where(and(eq(projects.accountId, accountId), eq(projects.status, 'active')));

  return c.json({
    account_id: row.accountId,
    name: row.name,
    personal_account: row.personalAccount,
    member_count: Number(memberCountRow?.n ?? 0),
    project_count: Number(projectCountRow?.n ?? 0),
    role: membership.accountRole,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
  },
);

// PATCH /v1/accounts/:accountId — rename. Gated on account.write via IAM.
accountsRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}',
    tags: ['accounts'],
    summary: 'Rename an account',
    ...auth,
    request: {
      params: AccountIdParam,
      body: { content: { 'application/json': { schema: z.object({ name: z.string() }) } } },
    },
    responses: {
      200: json(AccountSummarySchema, 'The updated account'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.ACCOUNT_WRITE);

  const body = await readBody(c);
  const name = normalizeString(body.name);
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 255) return c.json({ error: 'name is too long' }, 400);

  const [row] = await db
    .update(accounts)
    .set({ name, updatedAt: new Date() })
    .where(eq(accounts.accountId, accountId))
    .returning();
  if (!row) return c.json({ error: 'Not found' }, 404);

  return c.json(serializeAccount(row));
  },
);

// GET /v1/accounts/:accountId/members — list members.
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/members',
    tags: ['accounts'],
    summary: 'List account members',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.array(AccountMemberSchema), 'Account members'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);

  const rows = await db
    .select({
      userId: accountMembers.userId,
      accountRole: accountMembers.accountRole,
      isSuperAdmin: accountMembers.isSuperAdmin,
      joinedAt: accountMembers.joinedAt,
    })
    .from(accountMembers)
    .where(eq(accountMembers.accountId, accountId));

  const emails = await lookupEmailsByUserIds(rows.map((r) => r.userId));
  const projectGrantRows = await db
    .select({
      userId: projectMembers.userId,
      n: count(),
    })
    .from(projectMembers)
    .where(eq(projectMembers.accountId, accountId))
    .groupBy(projectMembers.userId);
  const projectGrantCountByUser = new Map(projectGrantRows.map((r) => [r.userId, Number(r.n ?? 0)]));

  // Group memberships for every member, in one query — so the member list can
  // show which groups each person belongs to without N round-trips. Wrapped so
  // a missing/drifted groups table degrades to "no chips" instead of 500-ing
  // the whole member list.
  const groupsByUser = new Map<string, Array<{ group_id: string; name: string }>>();
  try {
    const groupRows = await db
      .select({
        userId: accountGroupMembers.userId,
        groupId: accountGroups.groupId,
        name: accountGroups.name,
      })
      .from(accountGroupMembers)
      .innerJoin(accountGroups, eq(accountGroupMembers.groupId, accountGroups.groupId))
      .where(eq(accountGroups.accountId, accountId));
    for (const g of groupRows) {
      const list = groupsByUser.get(g.userId) ?? [];
      list.push({ group_id: g.groupId, name: g.name });
      groupsByUser.set(g.userId, list);
    }
  } catch {
    /* groups table unavailable — return members without group chips */
  }

  // Active-PAT counts per member, in one aggregate so the member list
  // can flag who's automating against the account. Best-effort —
  // failures degrade to "0".
  const patCountByUser = new Map<string, number>();
  try {
    const patRows = await db.execute<{ user_id: string; n: number }>(sql`
      SELECT user_id::text, COUNT(*)::int AS n
      FROM kortix.account_tokens
      WHERE account_id = ${accountId}::uuid AND status = 'active'
      GROUP BY user_id
    `);
    const patData = ((patRows as unknown) as { rows: typeof patRows }).rows ?? patRows;
    for (const row of patData as Array<{ user_id: string; n: number }>) {
      patCountByUser.set(row.user_id, row.n);
    }
  } catch {
    /* swallow — display "0 PATs" on failure */
  }

  // Verified-MFA flag per member from Supabase Auth. Same forgiving
  // fallback as above so the list never 500s if auth.mfa_factors is
  // unavailable in a given environment.
  const mfaByUser = new Map<string, boolean>();
  try {
    const mfaRows = await db.execute<{ user_id: string }>(sql`
      SELECT DISTINCT user_id::text
      FROM auth.mfa_factors
      WHERE status = 'verified'
        AND user_id IN (
          SELECT user_id FROM kortix.account_members WHERE account_id = ${accountId}::uuid
        )
    `);
    const mfaData = ((mfaRows as unknown) as { rows: typeof mfaRows }).rows ?? mfaRows;
    for (const row of mfaData as Array<{ user_id: string }>) {
      mfaByUser.set(row.user_id, true);
    }
  } catch {
    /* auth.mfa_factors unavailable in this env */
  }

  return c.json(
    rows.map((r) => ({
      user_id: r.userId,
      email: emails.get(r.userId) ?? null,
      account_role: r.accountRole,
      is_super_admin: r.isSuperAdmin,
      explicit_project_count: projectGrantCountByUser.get(r.userId) ?? 0,
      groups: groupsByUser.get(r.userId) ?? [],
      active_pat_count: patCountByUser.get(r.userId) ?? 0,
      has_verified_mfa: mfaByUser.get(r.userId) ?? false,
      joined_at: r.joinedAt.toISOString(),
    })),
  );
  },
);

// POST /v1/accounts/:accountId/members — invite a user by email. If the user
// exists, they're added immediately. Otherwise we create a pending invitation
// that auto-claims on first /v1/accounts call after signup.
accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/members',
    tags: ['accounts'],
    summary: 'Invite a user by email (added immediately or pending invite)',
    ...auth,
    request: {
      params: AccountIdParam,
      body: {
        content: {
          'application/json': {
            schema: z.object({ email: z.string(), role: z.string().optional() }),
          },
        },
      },
    },
    responses: {
      201: json(
        z.record(z.string(), z.any()),
        'Member added or pending invitation created',
      ),
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_INVITE);

  const body = await readBody(c);
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: 'A valid email is required' }, 400);

  const role: AccountRole = parseRole(body.role, ['admin', 'member']) ?? 'member';

  // Need account name for the invite email
  const [accountRow] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!accountRow) return c.json({ error: 'Account not found' }, 404);

  const targetUserId = await lookupUserIdByEmail(email);

  if (targetUserId) {
    const existing = await getMembership(targetUserId, accountId);
    if (existing) {
      return c.json({ error: 'Already a member' }, 409);
    }

    await db.insert(accountMembers).values({
      userId: targetUserId,
      accountId,
      accountRole: role,
    });

    // Billing v2 — mint YOLO + push +1 seat to Stripe (no-op for legacy).
    void onMemberAdded(accountId, targetUserId).catch(() => {});

    return c.json(
      {
        status: 'added',
        user_id: targetUserId,
        email,
        account_role: role,
      },
      201,
    );
  }

  // User doesn't exist — create or refresh a pending invitation.
  // Upsert on the unique (account_id, email) index; if one exists,
  // refresh expires_at + initial_role (e.g. inviter changed role).
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const [invite] = await db
    .insert(accountInvitations)
    .values({
      accountId,
      email,
      invitedBy: userId,
      initialRole: role,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [accountInvitations.accountId, accountInvitations.email],
      set: {
        initialRole: role,
        expiresAt,
        invitedBy: userId,
        // Clear any prior accepted_at so a refreshed invite is "pending" again.
        acceptedAt: null,
      },
    })
    .returning();

  const delivery = await sendAccountInviteEmail({
    email,
    accountName: accountRow.name,
    inviterEmail: callerEmail,
    inviteId: invite.inviteId,
    role: invite.initialRole === 'admin' ? 'admin' : 'member',
  });

  return c.json(
    {
      status: 'pending',
      invite_id: invite.inviteId,
      email,
      account_role: invite.initialRole,
      expires_at: invite.expiresAt.toISOString(),
      invite_url: buildInviteUrl(invite.inviteId),
      // false = email skipped or failed; UI surfaces the link so admin can share manually.
      email_sent: delivery.ok === true,
      email_skip_reason:
        delivery.ok === false && 'reason' in delivery ? delivery.reason : null,
    },
    201,
  );
  },
);

// GET /v1/accounts/:accountId/invites — list pending invitations.
accountsRouter.openapi(
  createRoute({
    method: 'get',
    path: '/{accountId}/invites',
    tags: ['accounts'],
    summary: 'List pending invitations',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(z.array(AccountInviteSchema), 'Pending invitations'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);

  const rows = await db
    .select()
    .from(accountInvitations)
    .where(
      and(
        eq(accountInvitations.accountId, accountId),
        isNull(accountInvitations.acceptedAt),
        gt(accountInvitations.expiresAt, new Date()),
      ),
    );

  return c.json(
    rows.map((r) => ({
      invite_id: r.inviteId,
      email: r.email,
      initial_role: r.initialRole,
      invited_by: r.invitedBy,
      created_at: r.createdAt.toISOString(),
      expires_at: r.expiresAt.toISOString(),
      invite_url: buildInviteUrl(r.inviteId),
    })),
  );
  },
);

// DELETE /v1/accounts/:accountId/invites/:inviteId — cancel a pending invite.
accountsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/invites/{inviteId}',
    tags: ['accounts'],
    summary: 'Cancel a pending invite',
    ...auth,
    request: { params: z.object({ accountId: z.string(), inviteId: z.string() }) },
    responses: {
      200: json(OkSchema, 'Cancellation result'),
      ...errors(401, 403),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const inviteId = c.req.param('inviteId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  // Cancelling a pending invite is part of invite admin — same capability.
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_INVITE);

  await db
    .delete(accountInvitations)
    .where(
      and(
        eq(accountInvitations.inviteId, inviteId),
        eq(accountInvitations.accountId, accountId),
      ),
    );

  return c.json({ ok: true });
  },
);

// POST /v1/accounts/:accountId/invites/:inviteId/resend — re-send the invite
// email and bump expires_at to a fresh 14-day window.
accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/invites/{inviteId}/resend',
    tags: ['accounts'],
    summary: 'Resend an invite email and refresh its expiry',
    ...auth,
    request: { params: z.object({ accountId: z.string(), inviteId: z.string() }) },
    responses: {
      200: json(
        z.object({
          ok: z.boolean(),
          expires_at: z.string(),
          invite_url: z.string(),
          email_sent: z.boolean(),
          email_skip_reason: z.string().nullable(),
        }),
        'Resend result',
      ),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
  const accountId = c.req.param('accountId');
  const inviteId = c.req.param('inviteId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Forbidden' }, 403);
  await assertAuthorized(userId, accountId, ACCOUNT_ACTIONS.MEMBER_INVITE);

  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  const [updated] = await db
    .update(accountInvitations)
    .set({ expiresAt })
    .where(
      and(
        eq(accountInvitations.inviteId, inviteId),
        eq(accountInvitations.accountId, accountId),
        isNull(accountInvitations.acceptedAt),
      ),
    )
    .returning();

  if (!updated) return c.json({ error: 'Invite not found' }, 404);

  const [accountRow] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);

  let delivery: Awaited<ReturnType<typeof sendAccountInviteEmail>> | null = null;
  if (accountRow) {
    delivery = await sendAccountInviteEmail({
      email: updated.email,
      accountName: accountRow.name,
      inviterEmail: callerEmail,
      inviteId: updated.inviteId,
      role: updated.initialRole === 'admin' ? 'admin' : 'member',
    });
  }

  return c.json({
    ok: true,
    expires_at: updated.expiresAt.toISOString(),
    invite_url: buildInviteUrl(updated.inviteId),
    email_sent: delivery?.ok === true,
    email_skip_reason:
      delivery && delivery.ok === false && 'reason' in delivery ? delivery.reason : null,
  });
  },
);

// DELETE /v1/accounts/:accountId/members/:userId — remove a member.
accountsRouter.openapi(
  createRoute({
    method: 'delete',
    path: '/{accountId}/members/{userId}',
    tags: ['accounts'],
    summary: 'Remove a member',
    ...auth,
    request: { params: z.object({ accountId: z.string(), userId: z.string() }) },
    responses: {
      200: json(OkSchema, 'Removal result'),
      ...errors(401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const callerUserId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  const callerMembership = await getMembership(callerUserId, accountId);
  if (!callerMembership) return c.json({ error: 'Forbidden' }, 403);
  await assertAuthorized(callerUserId, accountId, ACCOUNT_ACTIONS.MEMBER_REMOVE);

  const targetMembership = await getMembership(targetUserId, accountId);
  if (!targetMembership) return c.json({ error: 'Member not found' }, 404);

  // Admin cannot remove an owner — invariant preserved on top of IAM.
  if (callerMembership.accountRole === 'admin' && targetMembership.accountRole === 'owner') {
    return c.json({ error: 'Admins cannot remove owners' }, 403);
  }

  if (targetMembership.accountRole === 'owner') {
    const owners = await countOwners(accountId);
    if (owners <= 1) {
      return c.json({ error: 'Cannot remove the last owner' }, 409);
    }
  }

  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.accountId, accountId), eq(projectMembers.userId, targetUserId)));

  await db
    .delete(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, targetUserId)));

  // Billing v2 — revoke per-member YOLO + push -1 seat to Stripe.
  void onMemberRemoved(accountId, targetUserId).catch(() => {});

  return c.json({ ok: true });
  },
);

// PATCH /v1/accounts/:accountId/members/:userId — change role.
accountsRouter.openapi(
  createRoute({
    method: 'patch',
    path: '/{accountId}/members/{userId}',
    tags: ['accounts'],
    summary: "Change a member's role",
    ...auth,
    request: {
      params: z.object({ accountId: z.string(), userId: z.string() }),
      body: { content: { 'application/json': { schema: z.object({ role: z.string() }) } } },
    },
    responses: {
      200: json(
        z.object({
          user_id: z.string(),
          account_role: z.string(),
          unchanged: z.boolean().optional(),
        }),
        'The updated member role',
      ),
      ...errors(400, 401, 403, 404, 409),
    },
  }),
  async (c: any) => {
  const callerUserId = c.get('userId') as string;
  const accountId = c.req.param('accountId');
  const targetUserId = c.req.param('userId');

  const callerMembership = await getMembership(callerUserId, accountId);
  if (!callerMembership) return c.json({ error: 'Forbidden' }, 403);
  await assertAuthorized(callerUserId, accountId, ACCOUNT_ACTIONS.MEMBER_UPDATE);

  const body = await readBody(c);
  const newRole = parseRole(body.role, ['owner', 'admin', 'member']);
  if (!newRole) return c.json({ error: 'role must be one of owner|admin|member' }, 400);

  const targetMembership = await getMembership(targetUserId, accountId);
  if (!targetMembership) return c.json({ error: 'Member not found' }, 404);

  // Only an owner may assign or change the owner role.
  if ((newRole === 'owner' || targetMembership.accountRole === 'owner') &&
      !(await authorize(callerUserId, accountId, ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT)).allowed) {
    return c.json({ error: 'Only an owner can assign or change the owner role' }, 403);
  }

  if (targetMembership.accountRole === newRole) {
    return c.json({
      user_id: targetUserId,
      account_role: newRole,
      unchanged: true,
    });
  }

  // Preserved invariant: only an owner can grant the owner role. Otherwise
  // an admin with member.update could escalate any teammate to owner and
  // bypass every other restriction.
  if (newRole === 'owner' && callerMembership.accountRole !== 'owner') {
    return c.json({ error: 'Only owners can grant the owner role' }, 403);
  }

  if (targetMembership.accountRole === 'owner' && newRole !== 'owner') {
    const owners = await countOwners(accountId);
    if (owners <= 1) {
      return c.json({ error: 'Cannot demote the last owner' }, 409);
    }
  }

  await db
    .update(accountMembers)
    .set({ accountRole: newRole })
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, targetUserId)));

  if (newRole === 'owner' || newRole === 'admin') {
    // Owners/admins get implicit Manager on every project; their direct
    // project_members rows would shadow nothing useful, so clean them up.
    await db
      .delete(projectMembers)
      .where(and(eq(projectMembers.accountId, accountId), eq(projectMembers.userId, targetUserId)));
  }

  return c.json({
    user_id: targetUserId,
    account_role: newRole,
  });
  },
);

// POST /v1/accounts/:accountId/leave — leave an account.
accountsRouter.openapi(
  createRoute({
    method: 'post',
    path: '/{accountId}/leave',
    tags: ['accounts'],
    summary: 'Leave an account',
    ...auth,
    request: { params: AccountIdParam },
    responses: {
      200: json(OkSchema, 'Leave result'),
      ...errors(401, 404, 409),
    },
  }),
  async (c: any) => {
  const userId = c.get('userId') as string;
  const accountId = c.req.param('accountId');

  const membership = await getMembership(userId, accountId);
  if (!membership) return c.json({ error: 'Not a member' }, 404);

  const [account] = await db
    .select({ personalAccount: accounts.personalAccount })
    .from(accounts)
    .where(eq(accounts.accountId, accountId))
    .limit(1);
  if (!account) return c.json({ error: 'Not found' }, 404);

  if (account.personalAccount) {
    return c.json({ error: 'Personal accounts cannot be left' }, 409);
  }

  if (membership.accountRole === 'owner') {
    const owners = await countOwners(accountId);
    if (owners <= 1) {
      return c.json({ error: 'Cannot leave as the last owner — transfer ownership first' }, 409);
    }
  }

  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.accountId, accountId), eq(projectMembers.userId, userId)));

  await db
    .delete(accountMembers)
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));

  // Billing v2 — revoke YOLO + push -1 seat to Stripe on self-leave.
  void onMemberRemoved(accountId, userId).catch(() => {});

  return c.json({ ok: true });
  },
);

// Avoid unused-import lint warnings if sql tagged template isn't needed elsewhere.
void sql;
