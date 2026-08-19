/**
 * Project group grants — attach a group to a project at a role, change that
 * role, detach it, and read the project's grants with member counts.
 */

import { PROJECT_ACTIONS } from '../../iam';
import { invalidateIamCacheForGroup } from '../../iam/cache-invalidation';
import {
  assignRole,
  auditAssignmentRevoked,
  listAssignments,
  SYSTEM_ACTOR,
} from '../../iam/assignments';
import {
  accountRoleMap,
  groupProjectGrants,
  isAccountManagerRole,
} from '../../iam/read-models';
import { parseAssignableProjectRole, PROJECT_ROLE_INPUT_ERROR, type ProjectRole } from '../../iam/role-perms';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGroupMembers, accountGroups, accountMembers, projectGroupGrants } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { loadProjectForUser, parseExpiresAtBody, assertProjectCapability } from '../lib/access';
import { AnyObject, GroupGrantSchema, projectsApp } from '../lib/app';
import { normalizeString, readBody } from '../lib/serializers';
import { requireEntitlement } from '../../accounts/iam/helpers';

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/group-grants',
    tags: ['access'],
    summary: 'GET /:projectId/group-grants',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.array(GroupGrantSchema), 'Group grants'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_SESSION_READ);

  // From `role_assignments`, the store the engine reads. The group NAME is
  // still identity data on `account_groups`, and the inner-join semantics are
  // kept: an attachment whose group was deleted is not listed.
  const [assignments, groupRows] = await Promise.all([
    groupProjectGrants({ accountId: loaded.row.accountId, projectId }),
    db
      .select({ groupId: accountGroups.groupId, name: accountGroups.name })
      .from(accountGroups)
      .where(eq(accountGroups.accountId, loaded.row.accountId)),
  ]);
  const nameByGroup = new Map(groupRows.map((g) => [g.groupId, g.name] as const));
  const rows = assignments
    .filter((r) => nameByGroup.has(r.groupId))
    .map((r) => ({
      groupId: r.groupId,
      role: r.role,
      grantedBy: r.grantedBy,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      groupName: nameByGroup.get(r.groupId)!,
    }))
    // Deterministic order — without it the UI list visibly reshuffles after a
    // role flip. Oldest attachments first matches the "Attached <date>"
    // subtitle most users scan along.
    .sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() || a.groupId.localeCompare(b.groupId),
    );

  // Per-group member breakdown so the UI can flag attachments where the
  // grant role won't apply uniformly. When a group includes account
  // owners/admins, those users have implicit Manager on every project,
  // so the group's grant role is moot for them. Surfacing
  // override_count = N lets the project admin see at a glance "this
  // Viewer attachment doesn't actually viewer-cap 3 of these 5 people".
  const groupIds = rows.map((r) => r.groupId);
  type GroupStats = { total: number; overrideCount: number };
  const statsByGroup = new Map<string, GroupStats>();
  if (groupIds.length > 0) {
    const [memberRows, accountRoles] = await Promise.all([
      db
        .select({
          groupId: accountGroupMembers.groupId,
          isSuperAdmin: accountMembers.isSuperAdmin,
          userId: accountMembers.userId,
        })
        .from(accountGroupMembers)
        .innerJoin(
          accountMembers,
          and(
            eq(accountMembers.userId, accountGroupMembers.userId),
            eq(accountMembers.accountId, loaded.row.accountId),
          ),
        )
        .where(inArray(accountGroupMembers.groupId, groupIds)),
      accountRoleMap(loaded.row.accountId),
    ]);
    for (const m of memberRows) {
      const stats = statsByGroup.get(m.groupId) ?? { total: 0, overrideCount: 0 };
      stats.total += 1;
      if (m.isSuperAdmin || isAccountManagerRole(accountRoles.get(m.userId) ?? null)) {
        stats.overrideCount += 1;
      }
      statsByGroup.set(m.groupId, stats);
    }
  }

  return c.json({
    grants: rows.map((r) => {
      const stats = statsByGroup.get(r.groupId) ?? { total: 0, overrideCount: 0 };
      return {
        group_id: r.groupId,
        group_name: r.groupName,
        role: r.role,
        granted_by: r.grantedBy,
        created_at: r.createdAt.toISOString(),
        /** Auto-revoke timestamp. NULL = permanent attachment. */
        expires_at: r.expiresAt?.toISOString() ?? null,
        member_count: stats.total,
        // How many of the group's members are account owners/admins —
        // their implicit Manager access overrides this grant's role.
        override_count: stats.overrideCount,
      };
    }),
  });
},
);

// POST /v1/projects/:projectId/group-grants
// Attach a group to this project at the given role. Idempotent — if the
// group already has a grant, the role is updated.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/group-grants',
    tags: ['access'],
    summary: 'POST /:projectId/group-grants',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        201: json(GroupGrantSchema, 'The created group grant'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // assertProjectCapability (not bare assertAuthorized) so the acting token is
  // threaded and the agent-grant fold fires: an agent-session token must also
  // hold project.members.manage to mutate group grants, not just its user.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );
  // Entitlement mirror of accounts/iam/groups.ts so grants can't be minted
  // through the project-scoped path when the account-scoped one is gated.
  // Dormant since 2026-07-08: `rbac` is granted on every tier (groups + roles
  // are core collaboration, not an upsell) — it only bites again if the
  // packaging in tiers.ts changes.
  {
    const denied = await requireEntitlement(c, loaded.row.accountId, 'rbac');
    if (denied) return denied;
  }

  const body = await readBody(c);
  const groupId = normalizeString(body.group_id ?? body.groupId);
  // parseAssignableProjectRole folds the legacy `viewer`/`user` aliases into
  // `member` and REJECTS the removed `editor`, so a grant is never persisted
  // with a retired role and nobody is silently promoted to manager.
  const role = parseAssignableProjectRole(body.role);
  if (!groupId) return c.json({ error: 'group_id is required' }, 400);
  if (!role) {
    return c.json({ error: PROJECT_ROLE_INPUT_ERROR }, 400);
  }
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  // Confirm the group exists and belongs to this account — prevents
  // attaching a foreign-account group via a guessed UUID.
  const [group] = await db
    .select({ groupId: accountGroups.groupId })
    .from(accountGroups)
    .where(
      and(eq(accountGroups.groupId, groupId), eq(accountGroups.accountId, loaded.row.accountId)),
    )
    .limit(1);
  if (!group) return c.json({ error: 'group not found in this account' }, 404);

  const now = new Date();
  await db
    .insert(projectGroupGrants)
    .values({
      projectId,
      groupId,
      accountId: loaded.row.accountId,
      role,
      grantedBy: loaded.userId,
      expiresAt: expires.value ?? null,
    })
    .onConflictDoUpdate({
      target: [projectGroupGrants.projectId, projectGroupGrants.groupId],
      set: {
        role,
        grantedBy: loaded.userId,
        updatedAt: now,
        // Only overwrite when caller explicitly set the field.
        ...(expires.value !== undefined ? { expiresAt: expires.value } : {}),
      },
    });
  // …and the canonical grant, through the ONE write path. The route already
  // asserted `project.members.manage` above, so `SYSTEM_ACTOR` here does not
  // widen anything — it says "the caller was authorized by this route, not by
  // re-deriving a different action". Best-effort: the mirror trigger on
  // `project_group_grants` wrote the same canonical row inside the statement
  // above, so a failure costs the audit event, not the grant.
  await mirrorGroupGrant(loaded.row.accountId, projectId, groupId, role, expires.value ?? null);
  await invalidateIamCacheForGroup(groupId);

  return c.json({ project_id: projectId, group_id: groupId, role }, 201);
},
);

// PATCH /v1/projects/:projectId/group-grants/:groupId
// Change the role on an existing attachment. Returns 404 when there's
// nothing to change.

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/group-grants/{groupId}',
    tags: ['access'],
    summary: 'PATCH /:projectId/group-grants/:groupId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), groupId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const groupId = c.req.param('groupId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // assertProjectCapability (not bare assertAuthorized) so the acting token is
  // threaded and the agent-grant fold fires: an agent-session token must also
  // hold project.members.manage to mutate group grants, not just its user.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );
  // Same dormant entitlement mirror as the POST above (rbac is on every
  // tier). DELETE below carries no gate at all: revoking access is never
  // paywalled, so an account can always detach grants it can't manage.
  {
    const denied = await requireEntitlement(c, loaded.row.accountId, 'rbac');
    if (denied) return denied;
  }

  const body = await readBody(c);
  const role = parseAssignableProjectRole(body.role);
  if (!role) {
    return c.json({ error: PROJECT_ROLE_INPUT_ERROR }, 400);
  }
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const result = await db
    .update(projectGroupGrants)
    .set({
      role,
      updatedAt: new Date(),
      ...(expires.value !== undefined ? { expiresAt: expires.value } : {}),
    })
    .where(
        and(eq(projectGroupGrants.projectId, projectId), eq(projectGroupGrants.groupId, groupId)),
    )
    .returning({ groupId: projectGroupGrants.groupId });

  if (result.length === 0) return c.json({ error: 'grant not found' }, 404);
  await mirrorGroupGrant(loaded.row.accountId, projectId, groupId, role, expires.value ?? null);
  await invalidateIamCacheForGroup(groupId);
  return c.json({ project_id: projectId, group_id: groupId, role: body.role });
},
);

/**
 * The canonical half of a group→project grant.
 *
 * Best-effort on purpose: the mirror trigger on `project_group_grants` has
 * already written (or removed) the same `role_assignments` row inside the
 * caller's own statement, so the ENGINE is correct either way. What these add is
 * the single `iam.assignment.{granted,revoked}` audit event and the group
 * fan-out cache bust — bookkeeping that must never fail a legitimate grant.
 */
async function mirrorGroupGrant(
  accountId: string,
  projectId: string,
  groupId: string,
  role: ProjectRole,
  expiresAt: Date | null,
): Promise<void> {
  try {
    await assignRole(SYSTEM_ACTOR, accountId, {
      principal: { type: 'group', id: groupId },
      roleKey: role,
      scope: { type: 'project', id: projectId },
      expiresAt,
      source: 'manual',
    });
  } catch (err) {
    console.warn('[group-grants] canonical assignment failed', {
      projectId,
      groupId,
      err: (err as Error)?.message,
    });
  }
}

async function revokeGroupGrant(
  accountId: string,
  projectId: string,
  groupId: string,
): Promise<void> {
  try {
    const rows = await listAssignments({
      accountId,
      principal: { type: 'group', id: groupId },
      scopeType: 'project',
      scopeId: projectId,
      liveOnly: false,
    });
    for (const row of rows) {
      if (row.objectType !== null || !row.roleIsSystem) continue;
      await auditAssignmentRevoked(SYSTEM_ACTOR, accountId, row);
    }
  } catch (err) {
    console.warn('[group-grants] canonical revoke audit failed', {
      projectId,
      groupId,
      err: (err as Error)?.message,
    });
  }
}

// DELETE /v1/projects/:projectId/group-grants/:groupId
// Detach a group. Members of the group lose access via this grant
// immediately; any direct project_members row they have is unaffected.

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/group-grants/{groupId}',
    tags: ['access'],
    summary: 'DELETE /:projectId/group-grants/:groupId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), groupId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const groupId = c.req.param('groupId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // assertProjectCapability (not bare assertAuthorized) so the acting token is
  // threaded and the agent-grant fold fires: an agent-session token must also
  // hold project.members.manage to mutate group grants, not just its user.
    await assertProjectCapability(
      c,
      loaded.userId,
      loaded.row.accountId,
      projectId,
      PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
    );

  await revokeGroupGrant(loaded.row.accountId, projectId, groupId);
  await db
    .delete(projectGroupGrants)
    .where(
        and(eq(projectGroupGrants.projectId, projectId), eq(projectGroupGrants.groupId, groupId)),
    );
  await invalidateIamCacheForGroup(groupId);

  return c.json({ ok: true });
},
);
