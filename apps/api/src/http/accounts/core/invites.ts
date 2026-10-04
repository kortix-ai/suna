import { createRoute, z } from '@hono/zod-openapi';
import { accountInvitations, accountMemberships, accounts, projects } from '@kortix/db';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { onMemberAdded } from '../../../services/billing/services/seat-management';
import { ACCOUNT_ACTIONS, assertAuthorized, authorize } from '../../../services/iam';
import { resolveAccountIdentityByEmail } from '../../../services/iam/account-identity';
import { actorOf } from '../../middleware/actor';
import { parseAssignableProjectRole, PROJECT_ROLE_INPUT_ERROR, type ProjectRole } from '../../../services/iam/roles';
import { auth, errors, json } from '../../openapi';
import { grantProjectRole } from '../../../services/projects/lib/access';
import { db } from '../../../lib/db';
import { readJsonObject } from '../../lib/http-body';
import { buildInviteUrl, sendAccountInviteEmail } from '../../../services/accounts/email';
import { AccountIdParam, AccountInviteSchema, OkSchema, accountsRouter, getMembership, normalizeEmail, parseRole } from './app';
import { type AccountRole } from '../../../services/accounts/core/account-name';
import { grantAccountRole } from '../../../services/accounts/core/member-role-write';
import { logger } from '../../../lib/logger';

export function registerMemberInviteRoute(): void {
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
              schema: z.object({
                email: z.string(),
                role: z.string().optional(),
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
      const accountId = c.req.param('accountId');

      const membership = await getMembership(userId, accountId);
      if (!membership) return c.json({ error: 'Forbidden' }, 403);
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_INVITE);

      const body = await readJsonObject(c);
      const email = normalizeEmail(body.email);
      if (!email) return c.json({ error: 'A valid email is required' }, 400);

      const role: AccountRole = parseRole(body.role, ['admin', 'member']) ?? 'member';

      // Project grants only apply to `member` invites — an admin/owner
      // already holds implicit Manager on every project in the account (see
      // the PATCH role-change handler below, which strips their direct
      // project_members rows for the same reason), so a grant would be
      // redundant at best and misleading at worst.
      const rawGrants: Array<{ project_id?: unknown; role?: unknown }> = Array.isArray(
        body.project_grants,
      )
        ? body.project_grants
        : [];
      let projectGrants: Array<{ project_id: string; role: ProjectRole }> = [];
      if (rawGrants.length > 0 && role === 'member') {
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
              .select({ projectId: projects.projectId })
              .from(projects)
              .where(
                and(eq(projects.accountId, accountId), inArray(projects.projectId, requestedIds)),
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

      // Trial seat gate — covers both branches below (direct add + invite).
      const { trialSeatLimitBlocksNewMember } = await import(
        '../../../services/billing/services/seat-management'
      );
      const seatBlock = await trialSeatLimitBlocksNewMember(accountId);
      if (seatBlock) {
        return c.json(
          {
            error: `Your trial includes ${seatBlock.limit} ${seatBlock.limit === 1 ? 'seat' : 'seats'} and all are in use. Contact the Kortix team to extend the trial.`,
            code: 'trial_seat_limit_reached',
            limit: seatBlock.limit,
            members: seatBlock.members,
          },
          403,
        );
      }

      // Need account name for the invite email
      const [accountRow] = await db
        .select({ name: accounts.name })
        .from(accounts)
        .where(eq(accounts.accountId, accountId))
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

        // IDENTITY first, then the GRANT. Two stores, two writes: the row that
        // says "this user belongs to this account" (and carries is_super_admin /
        // scim_external_id) is kortix.account_memberships; the role is an
        // account-scope assignment. The route already asserted member.invite;
        // `assignRole` additionally asserts member.update, which owner and admin
        // both hold and no custom role can (both are non-delegable).
        await db.insert(accountMemberships).values({ userId: targetUserId, accountId });
        await grantAccountRole(await actorOf(c, accountId), accountId, targetUserId, role);
        // An account admin explicitly re-adding the same account-scoped person
        // clears the manual-removal tombstone. Future SAML logins may now sync
        // this identity again; SCIM can still deactivate it later.
        await db.execute(sql`
          UPDATE kortix.account_scim_users
          SET user_id=${targetUserId}::uuid, active=true, deleted_at=NULL, updated_at=now()
          WHERE account_id=${accountId}::uuid AND lower(user_name)=lower(${email})
        `);

        // Billing v2 — mint YOLO + push +1 seat to Stripe (no-op for legacy).
        void onMemberAdded(accountId, targetUserId).catch((err) =>
        // No seat reconciler exists: a failure here leaves the Stripe seat count
        // (and the member's YOLO token) wrong until the next member change.
        logger.error('[billing] seat sync FAILED after member added', { accountId: accountId, userId: targetUserId, error: err instanceof Error ? err.message : String(err) }),
      );

        for (const g of projectGrants) {
          await grantProjectRole({
            accountId,
            projectId: g.project_id,
            userId: targetUserId,
            role: g.role,
            grantedBy: userId,
          });
        }

        return c.json(
          {
            status: 'added',
            user_id: targetUserId,
            email,
            account_role: role,
            project_grants: projectGrants,
          },
          201,
        );
      }

      // User doesn't exist — create or refresh a pending invitation.
      // Upsert on the unique (account_id, email) index; if one exists,
      // refresh expires_at + initial_role (e.g. inviter changed role).
      // bootstrap_grants is fully replaced (not merged) on every call — the
      // caller resubmits the complete desired project-access set each time,
      // same "what you see is what you get" contract project_grants above
      // documents; a re-invite that no longer lists a project drops it.
      const bootstrapGrants = projectGrants.map((g) => ({
        project_id: g.project_id,
        role: g.role,
      }));
      const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
      const [invite] = await db
        .insert(accountInvitations)
        .values({
          accountId,
          email,
          invitedBy: userId,
          initialRole: role,
          expiresAt,
          bootstrapGrants,
        })
        .onConflictDoUpdate({
          target: [accountInvitations.accountId, accountInvitations.email],
          set: {
            initialRole: role,
            expiresAt,
            invitedBy: userId,
            // Clear any prior accepted_at so a refreshed invite is "pending" again.
            acceptedAt: null,
            bootstrapGrants,
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
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_INVITE);

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
}
