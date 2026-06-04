import { createRoute, z } from '@hono/zod-openapi';
import { and, count, eq } from 'drizzle-orm';
import { json, errors, auth } from '../../openapi';
import { accountMembers, accounts, accountUser, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { ACCOUNT_ACTIONS, assertAuthorized } from '../../iam';
import {
  accountsRouter,
  accountDisplayName,
  defaultAccountName,
  AccountSummarySchema,
  AccountDetailSchema,
  AccountIdParam,
  readBody,
  normalizeString,
  getMembership,
  serializeAccount,
  autoClaimPendingInvites,
} from './app';

// Routes are registered via this function (called by the orchestrator in the
// original route-registration order).
export function registerAccountRoutes(): void {
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
}
