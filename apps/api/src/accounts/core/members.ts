import { createRoute, z } from '@hono/zod-openapi';
import {
  accountGroupMembers,
  accountMemberships,
  projects,
} from '@kortix/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { onMemberRemoved } from '../../billing/services/seat-management';
import { ACCOUNT_ACTIONS, assertAuthorized, authorize } from '../../iam';
import { actorOf } from '../../iam/actor';
import { isAudienceObjectType } from '../../iam/audience-grants';
import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { accountGroupIds, accountGroupMembershipRows } from '../../iam/group-read';
import { accountDirectoryRows, verifiedMfaMemberIds } from '../../iam/membership-read';
import { auth, errors, json } from '../../openapi';
import {
  accountRoleMap,
  projectRoleGrants,
} from '../../iam/read-models';
import {
  auditAssignmentRevoked,
  deleteAccountScopeAssignments,
  deleteProjectScopeAssignments,
  listAssignments,
  type Writer,
} from '../../iam/assignments';
import { revokeAllAccountTokensForUser } from '../../repositories/account-tokens';
import { db } from '../../shared/db';
import { registerInviteRoutes, registerMemberInviteRoute } from './invites';
import { grantAccountRole } from './member-role-write';
import { canSeeSensitiveMemberColumns } from './member-visibility';
import {
  AccountIdParam,
  AccountMemberSchema,
  OkSchema,
  accountsRouter,
  countOwners,
  getMembership,
  lookupEmailsByUserIds,
  parseRole,
} from './app';
import { readJsonObject } from '../../shared/http-body';
import { logger } from '../../lib/logger';


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
    // Audience grants stay (`deleteProjectScopeAssignments`), so they are not revoked.
    for (const row of rows) {
      if (!isAudienceObjectType(row.objectType)) await auditAssignmentRevoked(writer, accountId, row);
    }
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
/**
 * Group grants are independent rows. Leaving them behind makes a later
 * re-invite restore access to groups this user was taken out of. Removal,
 * leave and SCIM deprovisioning all delete them (KRTX-1722).
 */
async function deleteAccountGroupMemberships(accountId: string, userId: string): Promise<void> {
  await db.delete(accountGroupMembers).where(and(
    eq(accountGroupMembers.userId, userId),
    inArray(accountGroupMembers.groupId, accountGroupIds(accountId)),
  ));
}

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
      //
      // Seven independent reads, each scoped to this account — none needs
      // another's result (`emails` is the one exception: it needs the member
      // user ids, so it's kicked off separately right below once `rows` is
      // known). These used to run one at a time (measured: 10 DB round trips
      // serialized to 479ms server time, 2026-09-27); firing them together
      // turns that sum into roughly the slowest single one. Each already
      // degrades independently (groups/PAT/MFA catch their own failures) so a
      // `Promise.all` rejection from the authorize/identity/role reads is the
      // only one allowed to fail the request — same as before.
      const [
        canManageMembers,
        identityRows,
        accountRoles,
        [assignedGrants, activeProjects],
        groupsByUser,
        patCountByUser,
        mfaByUser,
      ] = await Promise.all([
        authorize(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_INVITE).then((r) => r.allowed),
        // `account_members` is the DIRECTORY (who is here, since when, and the
        // is_super_admin bypass flag). The ROLE comes from `role_assignments` —
        // the one store the engine reads — so this list can no longer disagree
        // with what the gate says a moment later.
        accountDirectoryRows(accountId),
        accountRoleMap(accountId),
        // Direct project grants per member, one batched query (name + role, not
        // just a count) — powers both the "N projects" chip and a popover
        // listing exactly which projects. Active projects only; archived
        // projects don't clutter the chip. Group-derived and implicit
        // (owner/admin) access aren't rows in project_members, so neither is
        // enumerated here — that's the existing explicit_project_count scope.
        Promise.all([
          projectRoleGrants({ accountId }),
          db
            .select({ projectId: projects.projectId, name: projects.name })
            .from(projects)
            .where(and(eq(projects.accountId, accountId), eq(projects.status, 'active'))),
        ]),
        // Group memberships for every member, in one query — so the member list
        // can show which groups each person belongs to without N round-trips.
        // Wrapped so a missing/drifted groups table degrades to "no chips"
        // instead of 500-ing the whole member list.
        (async () => {
            const map = new Map<string, Array<{ group_id: string; name: string }>>();
            try {
              const groupRows = await accountGroupMembershipRows(accountId);
              for (const g of groupRows) {
                const list = map.get(g.userId) ?? [];
                list.push({ group_id: g.groupId, name: g.name });
                map.set(g.userId, list);
              }
            } catch {
              /* groups table unavailable — return members without group chips */
            }
            return map;
          })(),
          // Active-PAT counts per member, in one aggregate so the member list
          // can flag who's automating against the account. Best-effort —
          // failures degrade to "0".
          (async () => {
            const map = new Map<string, number>();
            try {
              const patRows = await db.execute<{ user_id: string; n: number }>(sql`
      SELECT user_id::text, COUNT(*)::int AS n
      FROM kortix.account_tokens
      WHERE account_id = ${accountId}::uuid AND status = 'active'
      GROUP BY user_id
    `);
              const patData = (patRows as unknown as { rows: typeof patRows }).rows ?? patRows;
              for (const row of patData as Array<{ user_id: string; n: number }>) {
                map.set(row.user_id, row.n);
              }
            } catch {
              /* swallow — display "0 PATs" on failure */
            }
            return map;
          })(),
          // Verified-MFA flag per member from Supabase Auth. Same forgiving
          // fallback as above so the list never 500s if auth.mfa_factors is
          // unavailable in a given environment.
          (async () => {
            const map = new Map<string, boolean>();
            try {
              const mfaRows = await verifiedMfaMemberIds(accountId);
              const mfaData = (mfaRows as unknown as { rows: typeof mfaRows }).rows ?? mfaRows;
              for (const row of mfaData as Array<{ user_id: string }>) {
                map.set(row.user_id, true);
              }
            } catch {
              /* auth.mfa_factors unavailable in this env */
            }
            return map;
          })(),
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

      // The one read that genuinely depends on another (`rows`'s user ids), so
      // it cannot join the batch above.
      const emails = await lookupEmailsByUserIds(rows.map((r) => r.userId));

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

  registerMemberInviteRoute();

  registerInviteRoutes();

  // DELETE /v1/accounts/:accountId/members/:userId — remove a member.
  accountsRouter.openapi(
    createRoute({
      method: 'delete',
      path: '/{accountId}/members/{userId}',
      tags: ['accounts'],
      summary: 'Remove a member',
      ...auth,
      request: { params: z.object({ accountId: z.string(), userId: z.string().uuid() }) },
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
      await deleteAccountGroupMemberships(accountId, targetUserId);
      await db
        .delete(accountMemberships)
        .where(
          and(
            eq(accountMemberships.accountId, accountId),
            eq(accountMemberships.userId, targetUserId),
          ),
        );
      // A manual removal is an account-scoped deprovisioning decision. Keep the
      // directory row as an inactive tombstone so the next SAML login cannot
      // recreate this member. A later SCIM active:true update is the explicit
      // IdP action that may restore access.
      await db.execute(sql`
        INSERT INTO kortix.account_scim_users
          (scim_id, account_id, user_id, user_name, active, profile, created_at, updated_at)
        SELECT gen_random_uuid(), ${accountId}::uuid, target.id, lower(target.email), false, '{}'::jsonb, now(), now()
        FROM auth.users target
        WHERE target.id=${targetUserId}::uuid AND target.email IS NOT NULL
        ON CONFLICT (account_id, user_name) DO UPDATE SET
          user_id=excluded.user_id,
          active=false,
          updated_at=now()
      `);
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
      void onMemberRemoved(accountId, targetUserId).catch((err) =>
        // No seat reconciler exists: a failure here leaves the Stripe seat count
        // (and the member's YOLO token) wrong until the next member change.
        logger.error('[billing] seat sync FAILED after member removed', { accountId: accountId, userId: targetUserId, error: err instanceof Error ? err.message : String(err) }),
      );

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
        params: z.object({ accountId: z.string(), userId: z.string().uuid() }),
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

      const body = await readJsonObject(c);
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
      // Demoting an owner also clears the super-admin bypass the owner held
      // (`clearSuperAdminAfterOwnerLoss`, run by the exclusive grant).
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
      await deleteAccountGroupMemberships(accountId, userId);
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
      void onMemberRemoved(accountId, userId).catch((err) =>
        // No seat reconciler exists: a failure here leaves the Stripe seat count
        // (and the member's YOLO token) wrong until the next member change.
        logger.error('[billing] seat sync FAILED after member removed', { accountId: accountId, userId: userId, error: err instanceof Error ? err.message : String(err) }),
      );

      return c.json({ ok: true });
    },
  );
}
