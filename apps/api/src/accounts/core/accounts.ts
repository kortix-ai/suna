import { createRoute, z } from "@hono/zod-openapi";
import { and, count, eq, sql } from "drizzle-orm";
import { json, errors, auth } from "../../openapi";
import { accountMembers, accountMemberships, accounts, projects } from "@kortix/db";
import { config } from "../../config";
import { db } from "../../shared/db";
import { ACCOUNT_ACTIONS, assertAuthorized } from "../../iam";
import { actorOf } from '../../iam/actor';
import { assignRole, SYSTEM_ACTOR } from '../../iam/assignments';
import { accountRolesForUser } from '../../iam/read-models';
import { impersonatedAccountFor } from "../../shared/impersonation";
import { isPlatformAdmin } from "../../shared/platform-roles";
import { effectiveBranding } from '../branding';
import { sortAccountsForListing } from "./account-order";
import { bootstrapPersonalAccount } from "./bootstrap-personal-account";
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

      // ACT-AS: the operator's OWN accounts are not part of this session. The
      // list is what the whole app scopes itself from — the sidebar reads it,
      // then asks for that account's projects — so returning the admin's own
      // memberships here would make every downstream call carry the wrong
      // account id, which `resolveScopedAccountId` then (correctly) refuses.
      // One account in, one account out: the account the banner names.
      const impersonated = impersonatedAccountFor(userId);
      if (impersonated) {
        const [row] = await db
          .select()
          .from(accounts)
          .where(eq(accounts.accountId, impersonated))
          .limit(1);
        if (!row) return c.json([]);
        return c.json([
          {
            account_id: row.accountId,
            name: accountDisplayName(row.name, null),
            slug: row.accountId.slice(0, 8),
            created_at: row.createdAt.toISOString(),
            updated_at: row.updatedAt.toISOString(),
            // Owner, matching the effective role every other gate resolves for
            // an impersonated request (see iam/engine-v2.ts and
            // projects/lib/git.ts). A lower label here would make the console
            // hide controls the server would in fact allow.
            account_role: 'owner',
            is_primary_owner: true,
            branding: await effectiveBranding(row.accountId, row.branding),
          },
        ]);
      }

      // `account_members` says WHICH accounts; `role_assignments` says at what
      // role. Reading the role off the join labelled the switcher with a value
      // the engine no longer decides on.
      const loadMemberships = async () => {
        const [membershipRows, rolesByAccount] = await Promise.all([
          db
            .select({
              accountId: accountMembers.accountId,
              name: accounts.name,
              createdAt: accounts.createdAt,
              updatedAt: accounts.updatedAt,
              branding: accounts.branding,
            })
            .from(accountMembers)
            .innerJoin(accounts, eq(accountMembers.accountId, accounts.accountId))
            .where(eq(accountMembers.userId, userId)),
          accountRolesForUser(userId),
        ]);
        return membershipRows.map((m) => ({
          ...m,
          accountRole: rolesByAccount.get(m.accountId) ?? 'member',
        }));
      };

      // Bootstrap BEFORE claiming pending invites, not after (R3). The old
      // order claimed invites first and only bootstrapped when the resulting
      // membership count was still zero — so the moment ANY invite was
      // pending, the claim alone made that count nonzero and the bootstrap
      // never ran. An invite-first signup then had no personal account at
      // all: its entire `GET /v1/accounts` was the inviter's org, and the
      // web landing door (which takes the first account in this list) put a
      // brand-new user straight into a stranger's workspace.
      //
      // `resolveAccountId` (shared/resolve-account.ts) never had this bug —
      // it bootstraps unconditionally the moment a caller has NO membership,
      // and never claims invites itself. Deciding on the PRE-claim
      // membership set here (not the post-claim one) makes this route agree
      // with that one: bootstrap fires exactly when the caller had no
      // account at all, independent of whether an invite is waiting.
      //
      // GET /v1/accounts/me (accounts/core/tokens.ts) applies the identical
      // pre-claim-decision ordering for the same reason — kept as a
      // parallel implementation rather than a shared helper because its
      // bootstrap primitive (`resolveAccountId`, best-effort, never fails
      // the request), gating (`authType === 'supabase'`), and response
      // shape all differ from this route's; forcing one function to cover
      // both would trade a 10-line ordering discipline for a multi-parameter
      // abstraction that hides the one real asymmetry that matters — this
      // route's bootstrap failure is fatal (500 below), /me's is not.
      let memberships = await loadMemberships();
      if (memberships.length === 0) {
        try {
          await bootstrapPersonalAccount(userId, userEmail);
        } catch (err) {
          console.warn('[accounts] Failed to bootstrap personal account:', err);
          return c.json({ error: 'Failed to initialize account' }, 500);
        }
      }

      // Claim AFTER the bootstrap decision above. `autoClaimPendingInvites`
      // already swallows its own errors (best-effort, must never block
      // listing) and is idempotent — a claimed invite is stamped
      // `accepted_at` and re-running is a no-op — so a claim failure here
      // leaves the user with exactly the personal account bootstrapped above
      // and the invite still pending, to be retried on the next call. No
      // shared transaction wraps the two steps: bootstrap failure is fatal
      // (500, above) because without it the account list is meaningless,
      // while invite-claiming is explicitly optional and self-healing, and
      // wrapping both in one transaction would contradict the per-invite
      // isolation `autoClaimPendingInvites` already does internally (one bad
      // invite must not roll back the others, or the account just bootstrapped).
      await autoClaimPendingInvites(userId, userEmail);

      memberships = await loadMemberships();
      if (memberships.length === 0) {
        console.warn(`[accounts] No memberships for ${userId} after bootstrap+claim`);
        return c.json({ error: 'Failed to initialize account' }, 500);
      }

      const displayNames = await resolveAccountDisplayNames(memberships, {
        userId,
        email: userEmail,
      });
      // Deterministic order (owned first, oldest first): the web landing
      // door falls back to the FIRST account of this list, so an unordered
      // result made the default landing account nondeterministic.
      // Branding is resolved per account — `effectiveBranding` only touches
      // billing for accounts that actually carry a record, so this stays a
      // no-op for the overwhelming majority of lists.
      return c.json(
        await Promise.all(
          sortAccountsForListing(memberships).map(async (m) => ({
            account_id: m.accountId,
            name: displayNames.get(m.accountId) ?? accountDisplayName(m.name, userEmail),
            slug: m.accountId.slice(0, 8),
            created_at: m.createdAt?.toISOString() ?? new Date().toISOString(),
            updated_at: m.updatedAt?.toISOString() ?? new Date().toISOString(),
            account_role: m.accountRole || 'owner',
            is_primary_owner: m.accountRole === 'owner',
            branding: await effectiveBranding(m.accountId, m.branding),
          })),
        ),
      );
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
        ...errors(400, 401, 403),
      },
    }),
    async (c: any) => {
      const userId = c.get("userId") as string;

      // Self-host account-creation restriction: gate the creation of
      // ADDITIONAL/org accounts to platform admins only. This is NOT the
      // removed single-account mode — signups, teams, and SSO/JIT all keep
      // working unchanged; only this "spin up a brand-new organization" path
      // is narrowed. The personal-account bootstrap (GET /v1/accounts →
      // bootstrapPersonalAccount) never calls this route, so every user still
      // lands in their own account regardless of this flag.
      if (config.KORTIX_RESTRICT_ACCOUNT_CREATION && !(await isPlatformAdmin(userId))) {
        return c.json(
          {
            error: 'Creating new accounts is restricted to the server admin on this deployment',
            code: 'account_creation_restricted',
          },
          403,
        );
      }

      const body = await readBody(c);
      const name = normalizeString(body.name);
      if (!name) return c.json({ error: 'name is required' }, 400);
      if (name.length > 255) return c.json({ error: 'name is too long' }, 400);

      const [account] = await db.insert(accounts).values({ name }).returning();

      // IDENTITY, then the OWNER role. `SYSTEM_ACTOR`: nobody holds a
      // permission in an account that did not exist a statement ago, so there is
      // no writer to authorize — creating it is the authorization.
      await db.insert(accountMemberships).values({
        userId,
        accountId: account.accountId,
        isSuperAdmin: true,
      });
      await assignRole(SYSTEM_ACTOR, account.accountId, {
        principal: { type: 'user', id: userId },
        roleKey: 'owner',
        scope: { type: 'account' },
        source: 'system',
        exclusive: true,
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
        branding: await effectiveBranding(row.accountId, row.branding),
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
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);

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
