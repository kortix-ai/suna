import { createRoute, z } from '@hono/zod-openapi';
import { accountInvitations, accountMemberships } from '@kortix/db';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS, addWorkspaceMember, assertAuthorized, authorize, workspaceFactsOf } from '../../iam';
import { SYSTEM_ACTOR } from '../../iam/assignments';
import { resolveAccountIdentityByEmail } from '../../iam/account-identity';
import { actorOf } from '../../iam/actor';
import {
  accountRoleForWorkspaceRole,
  parseAssignableProjectRole,
  parseWorkspaceRole,
  PROJECT_ROLE_INPUT_ERROR,
  type ProjectRole,
  type WorkspaceRole,
} from '../../iam/roles';
import { auth, errors, json } from '../../openapi';
import { parseExpiresAtBody } from '../../projects/lib/access';
import { db } from '../../shared/db';
import { readJsonObject } from '../../shared/http-body';
import { buildInviteUrl, sendAccountInviteEmail } from '../email';
import { AccountIdParam, AccountInviteSchema, type AccountRole, OkSchema, accountsRouter, getMembership, normalizeEmail } from './app';
import { logger } from '../../lib/logger';
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { captureProductEvent } from '../../shared/product-analytics';
import { accountIdParam } from '../../shared/route-params';
import { accountsView, projectsView } from '../../workspaces/rows';

type BootstrapEntry = NonNullable<(typeof accountInvitations.$inferInsert)['bootstrapGrants']>[number];

/**
 * The workspace-ladder role an invite grants, for its email: Admin, Manager
 * or Member. A Manager invite stores `initial_role: member` plus a manager
 * grant on the workspace's project in `bootstrap_grants` (applied at accept),
 * so the role is read back from both.
 */
export function inviteLadderRole(invite: {
  initialRole: string;
  bootstrapGrants?: unknown;
}): 'admin' | 'manager' | 'member' {
  if (invite.initialRole === 'admin' || invite.initialRole === 'owner') return 'admin';
  const grants = Array.isArray(invite.bootstrapGrants) ? invite.bootstrapGrants : [];
  const manages = grants.some(
    (grant) => grant !== null && typeof grant === 'object' && (grant as { role?: unknown }).role === 'manager',
  );
  return manages ? 'manager' : 'member';
}

export function registerMemberInviteRoute(): void {
  // POST /v1/accounts/:accountId/members — invite a user by email. If the user
  // exists, they're added immediately. Otherwise we create a pending invitation
  // that auto-claims on first /v1/accounts call after signup.
  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/members',
      tags: ['accounts'],
      summary: 'Invite a user by email (added immediately or pending invite)',
      ...auth,
      request: {
        params: AccountIdParam,
        body: {
          content: {
            'application/json': {
              schema: z.object({
                email: z.string(),
                /** The workspace ladder: admin | manager | member (default member). Owner is a transfer. */
                role: z.string().optional(),
                expires_at: z.string().nullable().optional(),
                // Project access to grant alongside the invite — applied
                // immediately if the invitee already has a Kortix account,
                // or staged on the pending invite (same bootstrap_grants
                // column POST /projects/:id/access/invite already writes)
                // and applied automatically when they accept.
                project_grants: z
                  .array(z.object({ project_id: z.string(), role: z.string().optional() }))
                  .optional(),
              }),
            },
          },
        },
      },
      responses: {
        201: json(z.record(z.string(), z.any()), 'Member added or pending invitation created'),
        ...errors(400, 401, 403, 404, 409),
      },
    }),
    async (c: any) => {
      const userId = c.get('userId') as string;
      const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
      const accountId = accountIdParam(c);

      const membership = await getMembership(userId, accountId);
      if (!membership) return c.json({ error: 'Forbidden' }, 403);
      const actor = await actorOf(c, accountId);
      const facts = await workspaceFactsOf(accountId);
      // Membership is access (design.md §3.2 C3): inviting is `member.invite`
      // on the workspace, or `project.members.manage` on its project (a
      // workspace manager invites too). Admin additionally needs member.update.
      const canInvite =
        (await authorize(actor, ACCOUNT_ACTIONS.MEMBER_INVITE)).allowed ||
        (facts.soleProjectId !== null &&
          (await authorize(actor, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, { type: 'workspace', id: facts.soleProjectId }))
            .allowed);
      if (!canInvite) await assertAuthorized(actor, ACCOUNT_ACTIONS.MEMBER_INVITE);

      const body = await readJsonObject(c);
      const email = normalizeEmail(body.email);
      if (!email) return c.json({ error: 'A valid email is required' }, 400);

      const parsedRole: WorkspaceRole | null = body.role === undefined ? 'member' : parseWorkspaceRole(body.role);
      let role: WorkspaceRole;
      if (parsedRole && parsedRole !== 'owner') {
        role = parsedRole;
      } else if (c.req.path.startsWith('/v1/workspaces/')) {
        return c.json({ error: 'role must be one of admin|manager|member (owner is a transfer)' }, 400);
      } else {
        // The legacy spelling always coerced an unknown role to `member`;
        // published CLIs and SDKs rely on it.
        role = 'member';
      }
      if (role === 'admin') await assertAuthorized(actor, ACCOUNT_ACTIONS.MEMBER_UPDATE);
      if (role === 'manager' && !facts.soleProjectId) {
        return c.json(
          { error: 'Manager needs a workspace that is set up. On a legacy account with several projects, grant Manager per project.' },
          400,
        );
      }
      const accountRole: AccountRole = accountRoleForWorkspaceRole(role);
      const expiry = parseExpiresAtBody(body.expires_at);
      if (!expiry.ok) return c.json({ error: expiry.error }, 400);
      const membershipExpiresAt = expiry.value ?? null;

      // `project_grants` is the per-project access of a split_pending legacy
      // account only. On a 1:1 workspace membership already IS access: a grant
      // naming the workspace itself is accepted and ignored, any other project
      // is a 400 (it cannot belong to this workspace).
      const rawGrants: Array<{ project_id?: unknown; role?: unknown }> = Array.isArray(
        body.project_grants,
      )
        ? body.project_grants
        : [];
      let projectGrants: Array<{ project_id: string; role: ProjectRole }> = [];
      const canonical = c.req.path.startsWith('/v1/workspaces/');
      if (!facts.splitPending) {
        const namesWorkspace = (g: { project_id?: unknown }) =>
          typeof g.project_id === 'string' && g.project_id.toLowerCase() === facts.soleProjectId;
        // The canonical route refuses a grant on another project; the legacy
        // route kept its old answer and drops it.
        if (canonical && rawGrants.some((g) => !namesWorkspace(g))) {
          return c.json({ error: 'project_grants may only name this workspace; membership already gives access to it' }, 400);
        }
        // A `manager` grant on the workspace is the manager rung (older clients
        // send it that way); a `member` grant adds nothing to membership.
        if (role === 'member' && rawGrants.some((g) => namesWorkspace(g) && parseAssignableProjectRole(g.role) === 'manager')) {
          role = 'manager';
        }
      } else if (rawGrants.length > 0 && accountRole === 'member') {
        const requestedIds = [
          ...new Set(
            rawGrants
              .map((g) => (typeof g.project_id === 'string' ? g.project_id : null))
              .filter((v): v is string => v !== null),
          ),
        ];
        // Never trust a client-supplied project_id at face value — confirm
        // it actually belongs to THIS account before granting, so a bad or
        // malicious payload can't plant a cross-account project_members row.
        const owned = requestedIds.length
          ? await db
              .select({ projectId: projectsView.projectId })
              .from(projectsView)
              .where(
                and(eq(projectsView.accountId, accountId), inArray(projectsView.projectId, requestedIds)),
              )
          : [];
        const ownedIds = new Set(owned.map((p) => p.projectId));
        for (const g of rawGrants) {
          const projectId = typeof g.project_id === 'string' ? g.project_id : null;
          if (!projectId || !ownedIds.has(projectId)) continue;
          // An omitted role still defaults to the floor tier; a role that was
          // SPELLED OUT and is not assignable (the removed `editor`, a typo) is
          // a 400, never a silent downgrade to `member` or upgrade to `manager`.
          const grantRole = g.role === undefined ? 'member' : parseAssignableProjectRole(g.role);
          if (!grantRole) return c.json({ error: PROJECT_ROLE_INPUT_ERROR }, 400);
          projectGrants.push({ project_id: projectId, role: grantRole });
        }
      }
      // A manager invite stores the project manager row on the workspace's
      // project, applied at once or at accept (bootstrap_grants).
      if (role === 'manager' && facts.soleProjectId) {
        projectGrants = [{ project_id: facts.soleProjectId, role: 'manager' }];
      }

      // Need account name for the invite email
      const [accountRow] = await db
        .select({ name: accountsView.name })
        .from(accountsView)
        .where(eq(accountsView.accountId, accountId))
        .limit(1);
      if (!accountRow) return c.json({ error: 'Account not found' }, 404);

      const identity = await resolveAccountIdentityByEmail(accountId, email);
      if (identity.ambiguous) {
        return c.json({ error: 'Multiple account identities use this email', code: 'account_identity_ambiguous' }, 409);
      }
      const targetUserId = identity.userId;

      if (targetUserId) {
        const existing = await getMembership(targetUserId, accountId);
        if (existing) {
          return c.json({ error: 'Already a member' }, 409);
        }

        // THE membership write: identity row, account role, the manager row
        // for a manager, explicit grants on a split_pending account.
        // `SYSTEM_ACTOR`: this route authorized the caller above (an admin
        // invite also asserted member.update); `grantedBy` names them.
        await addWorkspaceMember(
          accountId,
          targetUserId,
          role,
          role === 'manager' ? [] : projectGrants.map((g) => ({ projectId: g.project_id, role: g.role })),
          { writer: SYSTEM_ACTOR, source: 'invite', grantedBy: userId, expiresAt: membershipExpiresAt },
        );
        // An account admin explicitly re-adding the same account-scoped person
        // clears the manual-removal tombstone. Future SAML logins may now sync
        // this identity again; SCIM can still deactivate it later.
        await db.execute(sql`
          UPDATE kortix.account_scim_users
          SET user_id=${targetUserId}::uuid, active=true, deleted_at=NULL, updated_at=now()
          WHERE account_id=${accountId}::uuid AND lower(user_name)=lower(${email})
        `);

        captureProductEvent({
          userId: targetUserId,
          accountId,
          event: 'member_joined',
          properties: { via: 'direct_add', role },
        });

        return c.json(
          {
            status: 'added',
            user_id: targetUserId,
            email,
            role,
            account_role: accountRole,
            project_grants: projectGrants,
          },
          201,
        );
      }

      // User doesn't exist — create or refresh a pending invitation.
      // Upsert on the unique (account_id, email) index; if one exists,
      // refresh expires_at + initial_role (e.g. inviter changed role).
      // The project grants in bootstrap_grants are fully replaced (not merged)
      // on every call — the caller resubmits the complete desired
      // project-access set each time, same "what you see is what you get"
      // contract project_grants above documents; a re-invite that no longer
      // lists a project drops it. The `{group_id}` entries SCIM parked on a
      // still-pending invite stay: only the IdP adds or removes those
      // (KRTX-2329). An accepted invite already applied its groups, and
      // offboarding removed them, so a refresh never hands them back.
      const bootstrapGrants: BootstrapEntry[] = projectGrants.map((g) => ({
        project_id: g.project_id,
        role: g.role,
        ...(membershipExpiresAt ? { expires_at: membershipExpiresAt.toISOString() } : {}),
      }));
      // A time-boxed membership travels with the invite and is applied at accept
      // (`accounts/invites.ts`). An older API pod skips the entry as malformed.
      if (membershipExpiresAt) {
        bootstrapGrants.push({ account_expires_at: membershipExpiresAt.toISOString() } as unknown as BootstrapEntry);
      }
      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const [invite] = await db
        .insert(accountInvitations)
        .values({
          accountId,
          email,
          invitedBy: userId,
          initialRole: accountRole,
          expiresAt,
          bootstrapGrants,
        })
        .onConflictDoUpdate({
          target: [accountInvitations.accountId, accountInvitations.email],
          set: {
            initialRole: accountRole,
            expiresAt,
            invitedBy: userId,
            // Clear any prior accepted_at so a refreshed invite is "pending" again.
            acceptedAt: null,
            bootstrapGrants: sql`COALESCE((
              SELECT jsonb_agg(entry)
              FROM jsonb_array_elements(${qualifiedColumn(accountInvitations.bootstrapGrants)}) AS entry
              WHERE entry->>'group_id' IS NOT NULL
                AND ${qualifiedColumn(accountInvitations.acceptedAt)} IS NULL
            ), '[]'::jsonb) || excluded.bootstrap_grants`,
          },
        })
        .returning();

      const delivery = await sendAccountInviteEmail({
        email,
        accountName: accountRow.name,
        inviterEmail: callerEmail,
        inviteId: invite.inviteId,
        role: inviteLadderRole(invite),
      });

      return c.json(
        {
          status: 'pending',
          invite_id: invite.inviteId,
          email,
          role,
          account_role: invite.initialRole,
          project_grants: bootstrapGrants,
          expires_at: invite.expiresAt.toISOString(),
          invite_url: buildInviteUrl(invite.inviteId),
          // false = email skipped or failed; UI surfaces the link so admin can share manually.
          email_sent: delivery.ok === true,
          email_skip_reason: delivery.ok === false && 'reason' in delivery ? delivery.reason : null,
        },
        201,
      );
    },
  );
}

export function registerInviteRoutes(): void {
  // GET /v1/accounts/:accountId/invites — list pending invitations.
  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/invites',
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
      const accountId = accountIdParam(c);

      const membership = await getMembership(userId, accountId);
      if (!membership) return c.json({ error: 'Forbidden' }, 403);

      // Pending invites are member-management data — emails of people who
      // haven't even joined yet. Plain members get an empty list (not a 403)
      // so the members page renders without a special error path.
      const canManageMembers = (await authorize(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_INVITE))
        .allowed;
      if (!canManageMembers) return c.json([]);

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
      path: '/{workspaceId}/invites/{inviteId}',
      tags: ['accounts'],
      summary: 'Cancel a pending invite',
      ...auth,
      request: { params: z.object({ workspaceId: z.string(), inviteId: z.string() }) },
      responses: {
        200: json(OkSchema, 'Cancellation result'),
        ...errors(401, 403),
      },
    }),
    async (c: any) => {
      const userId = c.get('userId') as string;
      const accountId = accountIdParam(c);
      const inviteId = c.req.param('inviteId');

      const membership = await getMembership(userId, accountId);
      if (!membership) return c.json({ error: 'Forbidden' }, 403);
      // Cancelling a pending invite is part of invite admin — same capability.
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_INVITE);

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
  // email and bump expires_at to a fresh 14-day window. The resender becomes
  // the inviter, as a fresh Invite makes them: a SCIM invite an admin resends
  // is one a person shares, so a password email accepts it on an instance that
  // does not confirm emails (accounts/invites.ts addressedToCaller).
  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/invites/{inviteId}/resend',
      tags: ['accounts'],
      summary: 'Resend an invite email and refresh its expiry',
      ...auth,
      request: { params: z.object({ workspaceId: z.string(), inviteId: z.string() }) },
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
      const accountId = accountIdParam(c);
      const inviteId = c.req.param('inviteId');

      const membership = await getMembership(userId, accountId);
      if (!membership) return c.json({ error: 'Forbidden' }, 403);
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_INVITE);

      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const [updated] = await db
        .update(accountInvitations)
        .set({ expiresAt, invitedBy: userId })
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
        .select({ name: accountsView.name })
        .from(accountsView)
        .where(eq(accountsView.accountId, accountId))
        .limit(1);

      let delivery: Awaited<ReturnType<typeof sendAccountInviteEmail>> | null = null;
      if (accountRow) {
        delivery = await sendAccountInviteEmail({
          email: updated.email,
          accountName: accountRow.name,
          inviterEmail: callerEmail,
          inviteId: updated.inviteId,
          role: inviteLadderRole(updated),
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
}
