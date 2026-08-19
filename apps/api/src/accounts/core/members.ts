import { createRoute, z } from '@hono/zod-openapi';
import {
  accountGroupMembers,
  accountGroups,
  accountInvitations,
  accountMembers,
  accountMemberships,
  accounts,
  projects,
} from '@kortix/db';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { onMemberAdded, onMemberRemoved } from '../../billing/services/seat-management';
import { ACCOUNT_ACTIONS, assertAuthorized, authorize } from '../../iam';
import { actorOf } from '../../iam/actor';
import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { parseAssignableProjectRole, PROJECT_ROLE_INPUT_ERROR, type ProjectRole } from '../../iam/roles';
import { auth, errors, json } from '../../openapi';
import { grantProjectRole } from '../../projects/lib/access';
import {
  accountRoleMap,
  projectRoleGrants,
} from '../../iam/read-models';
import {
  assignRole,
  auditAssignmentRevoked,
  deleteAccountScopeAssignments,
  deleteProjectScopeAssignments,
  listAssignments,
  type Writer,
} from '../../iam/assignments';
import { revokeAllAccountTokensForUser } from '../../repositories/account-tokens';
import { db } from '../../shared/db';
import { lookupUserIdByEmail } from '../../shared/users';
import { buildInviteUrl, sendAccountInviteEmail } from '../email';
import { canSeeSensitiveMemberColumns } from './member-visibility';
import {
  AccountIdParam,
  AccountInviteSchema,
  AccountMemberSchema,
  type AccountRole,
  OkSchema,
  accountsRouter,
  countOwners,
  getMembership,
  lookupEmailsByUserIds,
  normalizeEmail,
  parseRole,
  readBody,
} from './app';


/**
 * The canonical half of an account-membership write.
 *
 * `account_members` is still written by these routes (a pre-cutover replica
 * reads it, and the mirror trigger derives the assignment from it), but the
 * ASSIGNMENT is what the engine reads, so every membership mutation goes
 * through `assignRole` / the revoke audit as well. Doing both is safe: the
 * trigger's upsert and `assignRole`'s upsert target the same identity index, so
 * the pair produces exactly ONE row.
 */
async function grantAccountRole(
  writer: Writer,
  accountId: string,
  userId: string,
  role: AccountRole,
): Promise<void> {
  // THE write. `account_members.account_role` is a derived view column as of the
  // cutover — there is no second store to keep in step, so a failure here is a
  // failure of the membership change and must propagate.
  //
  // `exclusive` reproduces what the single `account_role` COLUMN enforced: one
  // system account role per member, so owner -> admin retracts the owner
  // assignment instead of unioning with it.
  await assignRole(writer, accountId, {
    principal: { type: 'user', id: userId },
    roleKey: role,
    scope: { type: 'account' },
    source: 'system',
    exclusive: true,
  });
}

/**
 * Emit the revoke events for the account-scope system assignments a legacy
 * write just removed through the mirror trigger.
 *
 * `auditAssignmentRevoked`, not `revokeAssignment`: the caller has already run
 * its own last-owner guard (and, for a role CHANGE, is replacing the row rather
 * than removing access), so re-running the guard per row would 409 the very
 * demotion the route just validated.
 */
async function auditAccountRoleRevoked(
  writer: Writer,
  accountId: string,
  userId: string,
  keep?: string,
): Promise<void> {
  try {
    const rows = await listAssignments({
      accountId,
      principal: { type: 'user', id: userId },
      scopeType: 'account',
      liveOnly: false,
    });
    for (const row of rows) {
      if (!row.roleIsSystem || row.objectType !== null) continue;
      if (keep && row.roleKey === keep) continue;
      await auditAssignmentRevoked(writer, accountId, row);
    }
  } catch (err) {
    console.warn('[members] canonical account-role revoke audit failed', {
      accountId,
      userId,
      err: (err as Error)?.message,
    });
  }
}

/** Every project assignment a member holds, revoked with its audit event. */
async function auditProjectAssignmentsRevoked(
  writer: Writer,
  accountId: string,
  userId: string,
): Promise<void> {
  try {
    const rows = await listAssignments({
      accountId,
      principal: { type: 'user', id: userId },
      scopeType: 'project',
      liveOnly: false,
    });
    for (const row of rows) await auditAssignmentRevoked(writer, accountId, row);
  } catch (err) {
    console.warn('[members] canonical project-assignment revoke audit failed', {
      accountId,
      userId,
      err: (err as Error)?.message,
    });
  }
}

// Routes are registered via this function (called by the orchestrator in the
// original route-registration order).
export function registerMemberRoutes(): void {
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

      // The member directory is visible to EVERY member of the account (the way
      // Slack / GitHub show teammates within one company), so all rows are
      // returned. What stays gated is the SENSITIVE per-member data (PAT count,
      // MFA, group memberships, project grants): member-managers (owner / admin /
      // member.invite) see it on every row, everyone else only on their own —
      // enforced by canSeeSensitiveMemberColumns in the map below.
      const canManageMembers = (await authorize(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_INVITE))
        .allowed;

      // `account_members` is the DIRECTORY (who is here, since when, and the
      // is_super_admin bypass flag). The ROLE comes from `role_assignments` —
      // the one store the engine reads — so this list can no longer disagree
      // with what the gate says a moment later.
      const [identityRows, accountRoles] = await Promise.all([
        db
          .select({
            userId: accountMembers.userId,
            isSuperAdmin: accountMembers.isSuperAdmin,
            joinedAt: accountMembers.joinedAt,
          })
          .from(accountMembers)
          .where(eq(accountMembers.accountId, accountId)),
        accountRoleMap(accountId),
      ]);
      const rows = identityRows.map((r) => ({
        ...r,
        // Floor label for a directory row with no account-scope assignment:
        // the engine denies that principal outright, so `member` is the
        // weakest label that cannot overstate their access.
        accountRole: accountRoles.get(r.userId) ?? 'member',
      }));

      // Everyone in the account sees the full directory; sensitive columns are
      // gated per-row below.
      const visibleRows = rows;

      const emails = await lookupEmailsByUserIds(rows.map((r) => r.userId));
      // Direct project grants per member, one batched query (name + role, not
      // just a count) — powers both the "N projects" chip and a popover
      // listing exactly which projects. Active projects only; archived
      // projects don't clutter the chip. Group-derived and implicit
      // (owner/admin) access aren't rows in project_members, so neither is
      // enumerated here — that's the existing explicit_project_count scope.
      const [assignedGrants, activeProjects] = await Promise.all([
        projectRoleGrants({ accountId }),
        db
          .select({ projectId: projects.projectId, name: projects.name })
          .from(projects)
          .where(and(eq(projects.accountId, accountId), eq(projects.status, 'active'))),
      ]);
      const projectNameById = new Map(activeProjects.map((p) => [p.projectId, p.name] as const));
      const projectGrantRows = assignedGrants
        .filter((g) => projectNameById.has(g.projectId))
        .map((g) => ({
          userId: g.userId,
          projectId: g.projectId,
          role: g.projectRole as string,
          name: projectNameById.get(g.projectId)!,
        }));
      const projectGrantCountByUser = new Map<string, number>();
      const projectsByUser = new Map<
        string,
        Array<{ project_id: string; name: string; role: string }>
      >();
      for (const r of projectGrantRows) {
        projectGrantCountByUser.set(r.userId, (projectGrantCountByUser.get(r.userId) ?? 0) + 1);
        const list = projectsByUser.get(r.userId) ?? [];
        list.push({ project_id: r.projectId, name: r.name, role: r.role });
        projectsByUser.set(r.userId, list);
      }

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
        const patData = (patRows as unknown as { rows: typeof patRows }).rows ?? patRows;
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
        const mfaData = (mfaRows as unknown as { rows: typeof mfaRows }).rows ?? mfaRows;
        for (const row of mfaData as Array<{ user_id: string }>) {
          mfaByUser.set(row.user_id, true);
        }
      } catch {
        /* auth.mfa_factors unavailable in this env */
      }

      return c.json(
        visibleRows
          // Hide phantom self-memberships: a row where user_id == account_id whose
          // user_id has no auth user (no email). These are minted when a Kortix
          // token — which the auth middleware maps to userId == accountId — hits
          // resolveAccountId; they're the account added as a member of itself and
          // show as a bare UUID. A personal account's owner also has
          // user_id == account_id but resolves to a real email, so it's kept. The
          // email==null guard is narrow (real members have user_id != account_id),
          // so a transient email-lookup miss never hides a real teammate.
          .filter((r) => !(r.userId === accountId && (emails.get(r.userId) ?? null) === null))
          .map((r) => {
            // Sensitive columns (PATs, MFA, groups, grants) are visible on a
            // member's own row and to member-managers — never across rows for
            // plain members.
            const showSensitive = canSeeSensitiveMemberColumns(userId, r.userId, canManageMembers);
            return {
              user_id: r.userId,
              email: emails.get(r.userId) ?? null,
              account_role: r.accountRole,
              is_super_admin: r.isSuperAdmin,
              explicit_project_count: showSensitive
                ? (projectGrantCountByUser.get(r.userId) ?? 0)
                : 0,
              projects: showSensitive ? (projectsByUser.get(r.userId) ?? []) : [],
              groups: showSensitive ? (groupsByUser.get(r.userId) ?? []) : [],
              active_pat_count: showSensitive ? (patCountByUser.get(r.userId) ?? 0) : 0,
              has_verified_mfa: showSensitive ? (mfaByUser.get(r.userId) ?? false) : false,
              joined_at: r.joinedAt.toISOString(),
            };
          }),
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

      const body = await readBody(c);
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
        '../../billing/services/seat-management'
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

      const targetUserId = await lookupUserIdByEmail(email);

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

        // Billing v2 — mint YOLO + push +1 seat to Stripe (no-op for legacy).
        void onMemberAdded(accountId, targetUserId).catch(() => {});

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
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_REMOVE);

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

      // Audit BEFORE the deletes, while the rows still exist to describe.
      const remover = await actorOf(c, accountId);
      await auditProjectAssignmentsRevoked(remover, accountId, targetUserId);
      await auditAccountRoleRevoked(remover, accountId, targetUserId);

      // Membership is two facts now: the GRANTS in kortix.role_assignments and
      // the IDENTITY row in kortix.account_memberships. Offboarding removes
      // both. Grants first, so a failure between the two leaves the member
      // without access rather than with access and no identity.
      await deleteProjectScopeAssignments(accountId, targetUserId);
      await deleteAccountScopeAssignments(accountId, targetUserId);
      await db
        .delete(accountMemberships)
        .where(
          and(
            eq(accountMemberships.accountId, accountId),
            eq(accountMemberships.userId, targetUserId),
          ),
        );
      invalidateIamCacheForUser(targetUserId);
      // Offboarding is immediate: kill their PATs + live sandbox session tokens so a
      // removed member (and their running agents) can't keep acting on their bearer.
      // A revocation failure must NOT be swallowed — a removed member holding live
      // tokens is a silent offboarding hole. Log loudly; membership is already gone.
      await revokeAllAccountTokensForUser(targetUserId, accountId).catch((err) => {
        console.error(
          '[members] token revocation FAILED on member removal — removed user may retain live tokens',
          { targetUserId, accountId },
          err,
        );
      });

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
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_UPDATE);

      const body = await readBody(c);
      const newRole = parseRole(body.role, ['owner', 'admin', 'member']);
      if (!newRole) return c.json({ error: 'role must be one of owner|admin|member' }, 400);

      const targetMembership = await getMembership(targetUserId, accountId);
      if (!targetMembership) return c.json({ error: 'Member not found' }, 404);

      // Only an owner may assign or change the owner role.
      if (
        (newRole === 'owner' || targetMembership.accountRole === 'owner') &&
        !(await authorize(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_SUPER_ADMIN_GRANT))
          .allowed
      ) {
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

      const writer = await actorOf(c, accountId);
      await auditAccountRoleRevoked(writer, accountId, targetUserId, newRole);
      await db
      await grantAccountRole(writer, accountId, targetUserId, newRole);

      if (newRole === 'owner' || newRole === 'admin') {
        // Owners/admins get implicit Manager on every project; their direct
        // project assignments would shadow nothing useful, so clean them up.
        await auditProjectAssignmentsRevoked(writer, accountId, targetUserId);
        await deleteProjectScopeAssignments(accountId, targetUserId);
      }
      invalidateIamCacheForUser(targetUserId);

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

      // No personal/team distinction — any account can be left, EXCEPT the
      // last owner (that would orphan the account). That single rule prevents
      // the only real footgun the old "personal accounts can't be left" guard did.
      if (membership.accountRole === 'owner') {
        const owners = await countOwners(accountId);
        if (owners <= 1) {
          return c.json(
            { error: 'Cannot leave as the last owner — transfer ownership first' },
            409,
          );
        }
      }

      const leaver = await actorOf(c, accountId);
      await auditProjectAssignmentsRevoked(leaver, accountId, userId);
      await auditAccountRoleRevoked(leaver, accountId, userId);

      await deleteProjectScopeAssignments(accountId, userId);
      await deleteAccountScopeAssignments(accountId, userId);
      await db
        .delete(accountMemberships)
        .where(
          and(eq(accountMemberships.accountId, accountId), eq(accountMemberships.userId, userId)),
        );
      invalidateIamCacheForUser(userId);
      // Leaving revokes your own tokens for this account (PATs + live sessions).
      // Never swallow a revocation failure — surface it so a stuck token is visible.
      await revokeAllAccountTokensForUser(userId, accountId).catch((err) => {
        console.error(
          '[members] token revocation FAILED on self-leave — user may retain live tokens',
          { userId, accountId },
          err,
        );
      });

      // Billing v2 — revoke YOLO + push -1 seat to Stripe on self-leave.
      void onMemberRemoved(accountId, userId).catch(() => {});

      return c.json({ ok: true });
    },
  );
}
