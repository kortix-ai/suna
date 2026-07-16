import { createRoute, z } from "@hono/zod-openapi";
import { and, count, eq, sql } from "drizzle-orm";
import { json, errors, auth } from "../../openapi";
import { accountMembers, accounts, projects } from "@kortix/db";
import { bootstrapPersonalAccount } from "./bootstrap-personal-account";
import { db } from "../../shared/db";
import { ACCOUNT_ACTIONS, assertAuthorized } from "../../iam";
import {
  AccountDetailSchema,
  AccountIdParam,
  AccountSummarySchema,
  accountDisplayName,
  accountsRouter,
  autoClaimPendingInvites,
  getMembership,
  normalizeString,
  readBody,
  resolveAccountDisplayNames,
  serializeAccount,
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

      const memberships = await db
        .select({
          accountId: accountMembers.accountId,
          accountRole: accountMembers.accountRole,
          name: accounts.name,
          createdAt: accounts.createdAt,
          updatedAt: accounts.updatedAt,
        })
        .from(accountMembers)
        .innerJoin(accounts, eq(accountMembers.accountId, accounts.accountId))
        .where(eq(accountMembers.userId, userId));

      if (memberships.length > 0) {
        const displayNames = await resolveAccountDisplayNames(memberships, {
          userId,
          email: userEmail,
        });
        return c.json(
          memberships.map((m) => ({
            account_id: m.accountId,
            name: displayNames.get(m.accountId) ?? accountDisplayName(m.name, userEmail),
            slug: m.accountId.slice(0, 8),
            created_at: m.createdAt?.toISOString() ?? new Date().toISOString(),
            updated_at: m.updatedAt?.toISOString() ?? new Date().toISOString(),
            account_role: m.accountRole || 'owner',
            is_primary_owner: m.accountRole === 'owner',
          })),
        );
      }

      try {
        const { accountId } = await bootstrapPersonalAccount(userId, userEmail);
        const [row] = await db
          .select()
          .from(accounts)
          .where(eq(accounts.accountId, accountId))
          .limit(1);
        if (!row) {
          throw new Error(`Personal account ${accountId} missing after bootstrap`);
        }
        return c.json([
          {
            account_id: row.accountId,
            name: accountDisplayName(row.name, userEmail),
            slug: row.accountId.slice(0, 8),
            created_at: row.createdAt.toISOString(),
            updated_at: row.updatedAt.toISOString(),
            account_role: 'owner',
            is_primary_owner: true,
          },
        ]);
      } catch (err) {
        console.warn('[accounts] Failed to bootstrap personal account:', err);
        return c.json({ error: 'Failed to initialize account' }, 500);
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
        body: {
          content: {
            'application/json': { schema: z.object({ name: z.string() }) },
          },
        },
      },
      responses: {
        201: json(AccountSummarySchema, "The newly created account"),
        ...errors(400, 401),
      },
    }),
    async (c: any) => {
      const userId = c.get("userId") as string;
      const body = await readBody(c);
      const name = normalizeString(body.name);
      if (!name) return c.json({ error: 'name is required' }, 400);
      if (name.length > 255) return c.json({ error: 'name is too long' }, 400);

      const [account] = await db.insert(accounts).values({ name }).returning();

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

      // Member count EXCLUDING phantom self-memberships (user_id == account_id with
      // no auth user) — same definition as billing/countActiveMembers and the
      // members-list filter, so the "Members" counter matches the visible list and
      // the billed seat count. Personal-account owners (user_id == account_id but a
      // real auth user) are kept; falls back to a plain count if auth is unreachable.
      let memberCount = 0;
      try {
        const res = await db.execute<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM kortix.account_members am
      WHERE am.account_id = ${accountId}::uuid
        AND NOT (
          am.user_id = am.account_id
          AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = am.user_id)
        )
    `);
        const countRows =
          (res as unknown as { rows?: Array<{ n: number }> }).rows ??
          (res as unknown as Array<{ n: number }>);
        memberCount = Number(countRows?.[0]?.n ?? 0);
      } catch {
        const [memberCountRow] = await db
          .select({ n: count() })
          .from(accountMembers)
          .where(eq(accountMembers.accountId, accountId));
        memberCount = Number(memberCountRow?.n ?? 0);
      }
      const [projectCountRow] = await db
        .select({ n: count() })
        .from(projects)
        .where(and(eq(projects.accountId, accountId), eq(projects.status, 'active')));

      const displayNames = await resolveAccountDisplayNames(
        [{ accountId: row.accountId, name: row.name }],
        { userId, email: c.get('userEmail') as string },
      );

      return c.json({
        account_id: row.accountId,
        name: displayNames.get(row.accountId) ?? row.name,
        member_count: memberCount,
        project_count: Number(projectCountRow?.n ?? 0),
        role: membership.accountRole,
        mfa_required: row.mfaRequired ?? false,
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
        body: {
          content: {
            'application/json': { schema: z.object({ name: z.string() }) },
          },
        },
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
