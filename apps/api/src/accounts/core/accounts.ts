import { createRoute, z } from "@hono/zod-openapi";
import { and, count, eq } from "drizzle-orm";
import { json, errors, auth } from "../../openapi";
import { config } from "../../config";
import { db } from "../../shared/db";
import { ACCOUNT_ACTIONS, assertAuthorized } from "../../iam";
import { actorOf } from '../../iam/actor';
import { countAccountMembers, countBillableAccountMembers, userAccountRows } from '../../iam/membership-read';
import { accountRolesForUser } from '../../iam/read-models';
import { workspaceFactsOf } from '../../iam/workspace-facts';
import { impersonatedAccountFor } from "../../shared/impersonation";
import { isPlatformAdmin } from "../../shared/platform-roles";
import { effectiveBranding } from '../branding';
import { sortAccountsForListing } from "./account-order";
import { accountNameError } from "./account-name";
import { renameSoleProjectOfAccount } from "../../projects/surface";
import { createOwnedAccount } from "./create-account";
import { reportSignupWithoutWorkspace } from "./signup-event";
import {
  AccountDetailSchema,
  AccountIdParam,
  AccountSummarySchema,
  accountDisplayName,
  accountsRouter,
  autoClaimPendingInvites,
  getMembership,
  normalizeString,
  resolveAccountDisplayNames,
  serializeAccount,
} from './app';
import { readJsonObject } from '../../shared/http-body';
import { workspaceIdsForAccounts } from '../../shared/resolve-account';
import { accountIdParam } from '../../shared/route-params';
import { accountsView, projectsView, updateAccountRowsReturning } from '../../workspaces/rows';

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
        ...errors(401, 500),
      },
    }),
    async (c) => {
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
          .from(accountsView)
          .where(eq(accountsView.accountId, impersonated))
          .limit(1);
        if (!row) return c.json([]);
        const workspaceIds = await workspaceIdsForAccounts([row.accountId]);
        return c.json([
          {
            account_id: row.accountId,
            workspace_id: workspaceIds.get(row.accountId) ?? null,
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
      const readMembershipRows = () => userAccountRows(userId);
      const loadMemberships = async () => {
        const [membershipRows, rolesByAccount] = await Promise.all([
          readMembershipRows(),
          accountRolesForUser(userId),
        ]);
        return membershipRows.map((m) => ({
          ...m,
          accountRole: rolesByAccount.get(m.accountId) ?? 'member',
        }));
      };

      // No account is created here (Workspaces D3, 2026-11-05). A person
      // with no membership gets `[]` and the client shows the create-or-join
      // screen. The pre-claim read decides only whether this is a person
      // without a workspace, for the `user_signed_up` event.
      if ((await readMembershipRows()).length === 0 && c.get('authType') === 'supabase') {
        reportSignupWithoutWorkspace(userId);
      }

      // `autoClaimPendingInvites` swallows its own errors (best-effort, must
      // never block listing) and is idempotent — a claimed invite is stamped
      // `accepted_at` and re-running is a no-op — so a claim failure leaves
      // the invite pending, to be retried on the next call.
      await autoClaimPendingInvites(userId, userEmail);

      // Read unconditionally, after the claim. Reusing the pre-claim rows when
      // this request claimed nothing races a concurrent list: the first call of
      // a fresh sign-in claims the invite between this call's first read and
      // its claim, so this call sees no pending invite, claims 0, and would
      // return the list without the workspace the user was just added to.
      const allMemberships = await loadMemberships();
      // A workspace being deleted (K2) lists for its owners only, who can
      // restore it; every other member lost it when the delete committed (C3).
      const closing = await Promise.all(allMemberships.map(async (m) => (await workspaceFactsOf(m.accountId)).closing));
      const memberships = allMemberships.filter((m, i) => !closing[i] || m.accountRole === 'owner');
      if (memberships.length === 0) return c.json([]);

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
      const workspaceIds = await workspaceIdsForAccounts(memberships.map((m) => m.accountId));
      return c.json(
        await Promise.all(
          sortAccountsForListing(memberships).map(async (m) => ({
            account_id: m.accountId,
            workspace_id: workspaceIds.get(m.accountId) ?? null,
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
    async (c) => {
      const userId = c.get("userId") as string;

      // Self-host account-creation restriction: gate the creation of
      // ADDITIONAL/org accounts to platform admins only. This is NOT the
      // removed single-account mode — signups, teams, and SSO/JIT all keep
      // working unchanged; only this "spin up a brand-new organization" path
      // is narrowed. A new workspace (`new_workspace: true` on provision) is
      // gated by the same rule (projects/new-workspace.ts).
      if (config.KORTIX_RESTRICT_ACCOUNT_CREATION && !(await isPlatformAdmin(userId))) {
        return c.json(
          {
            error: 'Creating new accounts is restricted to the server admin on this deployment',
            code: 'account_creation_restricted',
          },
          403,
        );
      }

      const body = await readJsonObject(c);
      const name = normalizeString(body.name);
      const nameError = accountNameError(name);
      if (nameError || !name) return c.json({ error: nameError }, 400);

      const account = await createOwnedAccount({
        userId,
        name,
        email: c.get('userEmail') as string | undefined,
      });

      return c.json(
        {
          account_id: account.accountId,
          // A new account has no project yet: it becomes a workspace when one is created.
          workspace_id: null,
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
      path: '/{workspaceId}',
      tags: ['accounts'],
      summary: 'Get account details',
      ...auth,
      request: { params: AccountIdParam },
      responses: {
        200: json(AccountDetailSchema, 'Account details'),
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const userId = c.get('userId') as string;
      const accountId = accountIdParam(c);

      const membership = await getMembership(userId, accountId);
      if (!membership) return c.json({ error: 'Forbidden' }, 403);

      const [row] = await db
        .select()
        .from(accountsView)
        .where(eq(accountsView.accountId, accountId))
        .limit(1);
      if (!row) return c.json({ error: 'Not found' }, 404);

      // Member count EXCLUDING phantom self-memberships (user_id == account_id with
      // no auth user) — same definition as billing/countActiveMembers and the
      // members-list filter, so the "Members" counter matches the visible list and
      // the billed seat count. Personal-account owners (user_id == account_id but a
      // real auth user) are kept; falls back to a plain count if auth is unreachable.
      let memberCount = 0;
      try {
        const res = await countBillableAccountMembers(accountId);
        const countRows =
          (res as unknown as { rows?: Array<{ n: number }> }).rows ??
          (res as unknown as Array<{ n: number }>);
        memberCount = Number(countRows?.[0]?.n ?? 0);
      } catch {
        const [memberCountRow] = await countAccountMembers(accountId);
        memberCount = Number(memberCountRow?.n ?? 0);
      }
      const [projectCountRow] = await db
        .select({ n: count() })
        .from(projectsView)
        .where(and(eq(projectsView.accountId, accountId), eq(projectsView.status, 'active')));

      const displayNames = await resolveAccountDisplayNames(
        [{ accountId: row.accountId, name: row.name }],
        { userId, email: c.get('userEmail') as string },
      );

      const workspaceIds = await workspaceIdsForAccounts([row.accountId]);
      return c.json({
        account_id: row.accountId,
        workspace_id: workspaceIds.get(row.accountId) ?? null,
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
      path: '/{workspaceId}',
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
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (c) => {
      const userId = c.get('userId') as string;
      const accountId = accountIdParam(c);

      const membership = await getMembership(userId, accountId);
      if (!membership) return c.json({ error: 'Forbidden' }, 403);
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.ACCOUNT_WRITE);

      const body = await readJsonObject(c);
      const name = normalizeString(body.name);
      const nameError = accountNameError(name);
      if (nameError || !name) return c.json({ error: nameError }, 400);

      // Workspace name = account name = project name: the account's only
      // project is renamed first (its name lives in kortix.yaml), so a refused
      // commit renames neither row.
      const project = await renameSoleProjectOfAccount(accountId, name);
      if (!project.ok) return c.json({ error: project.error, code: project.code }, project.status);

      const [row] = await updateAccountRowsReturning(eq(accountsView.accountId, accountId), {
        name,
        updatedAt: new Date(),
      });
      if (!row) return c.json({ error: 'Not found' }, 404);

      const workspaceIds = await workspaceIdsForAccounts([row.accountId]);
      return c.json({ ...serializeAccount(row), workspace_id: workspaceIds.get(row.accountId) ?? null });
    },
  );
}
