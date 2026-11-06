import { createRoute, z } from '@hono/zod-openapi';
import { roleAssignments } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { ACCOUNT_ACTIONS, assertAuthorized, authorize, workspaceFactsOf } from '../../iam';
import { accountRoleForWorkspaceRole, parseWorkspaceRole, workspaceRoleFromRows } from '../../iam/roles';
import { actorOf } from '../../iam/actor';
import { visibleDirectory } from '../../iam/directory-visibility';
import { isAudienceObjectType } from '../../iam/audience-grants';
import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { accountGroupMembershipRows } from '../../iam/group-read';
import { accountDirectoryRows, verifiedMfaMemberIds } from '../../iam/membership-read';
import { auth, errors, json } from '../../openapi';
import {
  accountRoleMap,
  projectRoleGrants,
} from '../../iam/read-models';
import {
  assignRole,
  auditAssignmentRevoked,
  deleteProjectScopeAssignments,
  listAssignments,
  SYSTEM_ACTOR,
  type Writer,
} from '../../iam/assignments';
import { db } from '../../shared/db';
import { registerInviteRoutes, registerMemberInviteRoute } from './invites';
import { grantAccountRole } from './member-role-write';
import { canSeeSensitiveMemberColumns } from './member-visibility';
import { offboardMember } from './offboard-member';
import {
  AccountIdParam,
  AccountMemberSchema,
  OkSchema,
  accountsRouter,
  countOwners,
  getMembership,
  lookupEmailsByUserIds,
} from './app';
import { readJsonObject } from '../../shared/http-body';
import { accountIdParam } from '../../shared/route-params';
import { projectsView } from '../../workspaces/rows';


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

/** The user's live system `manager` row on one project, or null. */
async function projectManagerAssignment(accountId: string, userId: string, projectId: string) {
  const rows = await listAssignments({
    accountId,
    principal: { type: 'user', id: userId },
    scopeType: 'project',
    scopeId: projectId,
  });
  return rows.find((row) => row.roleIsSystem && row.objectType === null && row.roleKey === 'manager') ?? null;
}

// Routes are registered via this function (called by the orchestrator in the
// original route-registration order).
export function registerMemberRoutes(): void {
  // GET /v1/accounts/:accountId/members — list members.
  accountsRouter.openapi(
    createRoute({
      method: 'get',
      path: '/{workspaceId}/members',
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
      const accountId = accountIdParam(c);

      const membership = await getMembership(userId, accountId);
      if (!membership) return c.json({ error: 'Forbidden' }, 403);

      // Which ROWS: `member.read` (owners and admins) lists every member. A
      // plain member lists only the people they share access with
      // (iam/directory-visibility.ts). Which COLUMNS: the SENSITIVE per-member
      // data (PAT count, MFA, group memberships, project grants) shows on every
      // row to member-managers (owner / admin / member.invite) and on their own
      // row to everyone else — canSeeSensitiveMemberColumns in the map below.
      //
      // Eight independent reads, each scoped to this account — none needs
      // another's result (`emails` is the one exception: it needs the member
      // user ids, so it's kicked off separately right below once `rows` is
      // known). These used to run one at a time (measured: 10 DB round trips
      // serialized to 479ms server time, 2026-09-27); firing them together
      // turns that sum into roughly the slowest single one. Each already
      // degrades independently (groups/PAT/MFA catch their own failures) so a
      // `Promise.all` rejection from the authorize/identity/role reads is the
      // only one allowed to fail the request — same as before.
      const actor = await actorOf(c, accountId);
      const [
        canManageMembers,
        visible,
        identityRows,
        accountRoles,
        [assignedGrants, activeProjects],
        groupsByUser,
        patCountByUser,
        mfaByUser,
      ] = await Promise.all([
        authorize(actor, ACCOUNT_ACTIONS.MEMBER_INVITE).then((r) => r.allowed),
        visibleDirectory(actor),
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
            .select({ projectId: projectsView.projectId, name: projectsView.name })
            .from(projectsView)
            .where(and(eq(projectsView.accountId, accountId), eq(projectsView.status, 'active'))),
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

      const visibleRows = visible.userIds
        ? rows.filter((r) => visible.userIds!.has(r.userId))
        : rows;

      // The one read that genuinely depends on another (`rows`'s user ids), so
      // it cannot join the batch above.
      const emails = await lookupEmailsByUserIds(visibleRows.map((r) => r.userId));

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
        Array<{ project_id: string; workspace_id: string; name: string; role: string }>
      >();
      // The ladder role on the workspace's one project (1:1); a split_pending
      // account has no single workspace project, so a member reads `member`.
      const soleProjectId = activeProjects.length === 1 ? activeProjects[0]!.projectId : null;
      const projectRoleOnWorkspace = new Map<string, string>();
      for (const r of projectGrantRows) {
        if (r.projectId === soleProjectId) projectRoleOnWorkspace.set(r.userId, r.role);
      }
      for (const r of projectGrantRows) {
        projectGrantCountByUser.set(r.userId, (projectGrantCountByUser.get(r.userId) ?? 0) + 1);
        const list = projectsByUser.get(r.userId) ?? [];
        list.push({ project_id: r.projectId, workspace_id: r.projectId, name: r.name, role: r.role });
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
              role: workspaceRoleFromRows(r.accountRole, projectRoleOnWorkspace.get(r.userId) ?? null) ?? 'member',
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
      path: '/{workspaceId}/members/{userId}',
      tags: ['accounts'],
      summary: 'Remove a member',
      ...auth,
      request: { params: z.object({ workspaceId: z.string(), userId: z.string().uuid() }) },
      responses: {
        200: json(OkSchema, 'Removal result'),
        ...errors(401, 403, 404, 409),
      },
    }),
    async (c: any) => {
      const callerUserId = c.get('userId') as string;
      const accountId = accountIdParam(c);
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

      await offboardMember(await actorOf(c, accountId), accountId, targetUserId, 'removed');
      return c.json({ ok: true });
    },
  );

  // PATCH /v1/accounts/:accountId/members/:userId — change role.
  accountsRouter.openapi(
    createRoute({
      method: 'patch',
      path: '/{workspaceId}/members/{userId}',
      tags: ['accounts'],
      summary: "Change a member's role",
      ...auth,
      request: {
        params: z.object({ workspaceId: z.string(), userId: z.string().uuid() }),
        body: { content: { 'application/json': { schema: z.object({ role: z.string() }) } } },
      },
      responses: {
        200: json(
          z.object({
            user_id: z.string(),
            /** The workspace ladder role: owner | admin | manager | member. */
            role: z.string(),
            /** Deprecated: the stored account-scope role. */
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
      const accountId = accountIdParam(c);
      const targetUserId = c.req.param('userId');

      const callerMembership = await getMembership(callerUserId, accountId);
      if (!callerMembership) return c.json({ error: 'Forbidden' }, 403);
      await assertAuthorized(await actorOf(c, accountId), ACCOUNT_ACTIONS.MEMBER_UPDATE);

      const body = await readJsonObject(c);
      // The one ladder (design.md §3.2 C3). `manager` = account member +
      // project manager on the workspace's one project.
      const newRole = parseWorkspaceRole(body.role);
      if (!newRole) return c.json({ error: 'role must be one of owner|admin|manager|member' }, 400);
      const newAccountRole = accountRoleForWorkspaceRole(newRole);

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

      const { soleProjectId } = await workspaceFactsOf(accountId);
      if (newRole === 'manager' && !soleProjectId) {
        return c.json(
          { error: 'Manager needs a workspace that is set up. On a legacy account with several projects, grant Manager per project.' },
          400,
        );
      }
      const managerRow = soleProjectId ? await projectManagerAssignment(accountId, targetUserId, soleProjectId) : null;
      const currentRole =
        workspaceRoleFromRows(targetMembership.accountRole, managerRow ? 'manager' : null) ?? 'member';

      if (currentRole === newRole) {
        return c.json({
          user_id: targetUserId,
          role: newRole,
          account_role: newAccountRole,
          unchanged: true,
        });
      }

      // Preserved invariant: only an owner can grant the owner role. Otherwise
      // an admin with member.update could escalate any teammate to owner and
      // bypass every other restriction.
      if (newRole === 'owner' && callerMembership.accountRole !== 'owner') {
        return c.json({ error: 'Only owners can grant the owner role' }, 403);
      }

      if (targetMembership.accountRole === 'owner' && newAccountRole !== 'owner') {
        const owners = await countOwners(accountId);
        if (owners <= 1) {
          return c.json({ error: 'Cannot demote the last owner' }, 409);
        }
      }

      const writer = await actorOf(c, accountId);
      if (targetMembership.accountRole !== newAccountRole) {
        await auditAccountRoleRevoked(writer, accountId, targetUserId, newAccountRole);
        // Demoting an owner also clears the super-admin bypass the owner held
        // (`clearSuperAdminAfterOwnerLoss`, run by the exclusive grant).
        await grantAccountRole(writer, accountId, targetUserId, newAccountRole);
      }

      if (newRole === 'owner' || newRole === 'admin') {
        // Owners/admins get implicit Manager on every project; their direct
        // project assignments would shadow nothing useful, so clean them up.
        await auditProjectAssignmentsRevoked(writer, accountId, targetUserId);
        await deleteProjectScopeAssignments(accountId, targetUserId);
      } else if (newRole === 'manager' && soleProjectId) {
        // The route asserted member.update; `SYSTEM_ACTOR` skips re-deriving
        // project.members.manage, `grantedBy` names the caller.
        await assignRole(SYSTEM_ACTOR, accountId, {
          principal: { type: 'user', id: targetUserId },
          roleKey: 'manager',
          scope: { type: 'project', id: soleProjectId },
          source: 'manual',
          exclusive: true,
          grantedBy: callerUserId,
        });
      } else if (newRole === 'member' && managerRow) {
        // Membership is access: a member needs no project row, so the manager
        // row goes and nothing replaces it.
        await auditAssignmentRevoked(writer, accountId, managerRow);
        await db.delete(roleAssignments).where(eq(roleAssignments.assignmentId, managerRow.assignmentId));
      }
      invalidateIamCacheForUser(targetUserId);
      if (newAccountRole === 'member') {
        // An owner or admin reached every company drive; as a member they reach
        // only what is granted, and drives they attached by role leave now.
        await import('../../drives/service').then(({ enforceDriveMounts }) => enforceDriveMounts({ accountId }));
      }

      return c.json({
        user_id: targetUserId,
        role: newRole,
        account_role: newAccountRole,
      });
    },
  );

  // POST /v1/accounts/:accountId/leave — leave an account.
  accountsRouter.openapi(
    createRoute({
      method: 'post',
      path: '/{workspaceId}/leave',
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
      const accountId = accountIdParam(c);

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

      await offboardMember(await actorOf(c, accountId), accountId, userId, 'left');
      return c.json({ ok: true });
    },
  );
}
