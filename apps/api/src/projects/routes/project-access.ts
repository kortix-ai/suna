/** Project members: the access roster and per-member role changes and removal. */
import { PROJECT_ACTIONS } from '../../iam';
import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { actorOf } from '../../iam/actor';
import { revokeProjectRole } from '../../iam/assignments';
import { parseAssignableProjectRole, PROJECT_ROLE_INPUT_ERROR } from '../../iam/roles';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { isAccountManager, roleAllows, type AccountRole } from '../access';
import {
  accountRoleMap,
  customRoleBindings,
  groupProjectGrants,
  objectGrantRows,
  projectRoleGrants,
} from '../../iam/read-models';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGroups, accountMembers } from '@kortix/db';
import { eq } from 'drizzle-orm';
import {
  grantProjectRole,
  loadProjectForUser,
  parseExpiresAtBody,
  assertProjectCapability,
} from '../lib/access';
import { AccessMemberSchema, AnyObject, projectsApp } from '../lib/app';
import { getAccountMembership } from '../lib/git';
import { readJsonObject } from '../../shared/http-body';
import { loadAccessGroupMembers, projectAccessView } from '../lib/project-access-view';

// GET /v1/projects/:projectId/access
// Lists every account member and their explicit/effective project access.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/access',
    tags: ['access'],
    summary: 'GET /:projectId/access',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.array(AccessMemberSchema), 'Access members'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_READ);

  // EVERY grant below comes from `kortix.role_assignments` via iam/read-models.
  // The five queries this used to run (account_members.account_role,
  // project_members, project_group_grants, iam_policies, iam_resource_grants)
  // were five stores the engine no longer reads, so this screen could and did
  // disagree with the gate that ran a moment later. `account_members` survives
  // here for IDENTITY only — who is in the directory, and when they joined.
  const [identityRows, accountRoles, grantRows, groupGrantRows, customPolicyRows, objectGrants, accountGroupRows] =
    await Promise.all([
      db
        .select({
          userId: accountMembers.userId,
          joinedAt: accountMembers.joinedAt,
        })
        .from(accountMembers)
        .where(eq(accountMembers.accountId, loaded.row.accountId)),
      accountRoleMap(loaded.row.accountId),
      projectRoleGrants({ accountId: loaded.row.accountId, projectId: loaded.row.projectId }),
      // Group grants attached to this project. Each row lifts everyone in the
      // group to at least the grant's role here; the per-user fan-out happens
      // below.
      groupProjectGrants({ accountId: loaded.row.accountId, projectId: loaded.row.projectId }),
      // Custom-role bindings that REACH this project: its own, plus every
      // account-scoped one (an account-scoped custom role covers every project).
      // member/group principals only — a service account is not a human to fold
      // onto the members list.
      customRoleBindings({
        accountId: loaded.row.accountId,
        reachingProjectId: loaded.row.projectId,
        // member/group only, as the legacy query said in so many words: a
        // service account is a machine identity, not a row on a people list.
        principalTypes: ['member', 'group'],
      }),
      // Per-object (agent/skill) grants for this project.
      objectGrantRows({ accountId: loaded.row.accountId, projectId: loaded.row.projectId }),
      // All groups on this account, for name resolution below. Custom-role
      // bindings and object grants can target a group that never got a project
      // role grant, so this is the superset lookup.
      db
        .select({ groupId: accountGroups.groupId, name: accountGroups.name })
        .from(accountGroups)
        .where(eq(accountGroups.accountId, loaded.row.accountId)),
    ]);

  const groupMemberRows = await loadAccessGroupMembers({ groupGrantRows, customPolicyRows, objectGrants, accountGroupRows });
  const { members, groupAccess } = await projectAccessView({
    identityRows, accountRoles, grantRows, groupGrantRows, customPolicyRows, objectGrants, accountGroupRows, groupMemberRows,
  });

  return c.json({
    project_id: loaded.row.projectId,
    account_id: loaded.row.accountId,
    can_manage: roleAllows(loaded.effectiveRole, 'manage'),
    viewer_user_id: loaded.userId,
    members,
    /** Every group with SOME access to this project — a project-role grant,
     *  a custom-role policy, or a per-resource grant — independent of the
     *  per-user fold above. Lets the UI show group-level access directly
     *  instead of only inferring it from members' `custom_role_policies`. */
    group_access: groupAccess,
  });
},
);

projectsApp.openapi(
  createRoute({
    method: 'put',
    path: '/{projectId}/access/{userId}',
    tags: ['access'],
    summary: 'PUT /:projectId/access/:userId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), userId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const targetUserId = c.req.param('userId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Member management is admin-only; loadProjectForUser('manage') now
  // resolves to project.write, so we add an explicit
  // stricter gate here.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const body = await readJsonObject(c);
  const role = parseAssignableProjectRole(body.role);
  if (!role) return c.json({ error: PROJECT_ROLE_INPUT_ERROR }, 400);
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const targetMembership = await getAccountMembership(targetUserId, loaded.row.accountId);
  if (!targetMembership) {
    return c.json({ error: 'User is not a member of this account' }, 404);
  }

  const targetAccountRole = targetMembership.accountRole as AccountRole;
  if (isAccountManager(targetAccountRole)) {
    // An owner/admin already has implicit Manager on every project, so a direct
    // project-role assignment adds nothing and only confuses the members list.
    // The route asserted project.members.manage above; `revokeProjectRole`
    // carries that through rather than re-deriving a different permission.
    await revokeProjectRole(await actorOf(c, loaded.row.accountId), loaded.row.accountId, projectId, {
      type: 'user',
      id: targetUserId,
    });
    invalidateIamCacheForUser(targetUserId);

    return c.json({
      user_id: targetUserId,
      account_role: targetAccountRole,
      project_role: null,
      effective_project_role: 'manager',
      has_implicit_access: true,
    });
  }

  await grantProjectRole({
    accountId: loaded.row.accountId,
    projectId,
    userId: targetUserId,
    role,
    grantedBy: loaded.userId,
    expiresAt: expires.value,
  });

  return c.json({
    user_id: targetUserId,
    account_role: targetAccountRole,
    project_role: role,
    effective_project_role: role,
    has_implicit_access: false,
  });
},
);

// DELETE /v1/projects/:projectId/access/:userId

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/access/{userId}',
    tags: ['access'],
    summary: 'DELETE /:projectId/access/:userId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), userId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const targetUserId = c.req.param('userId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const targetMembership = await getAccountMembership(targetUserId, loaded.row.accountId);
  if (!targetMembership) {
    return c.json({ error: 'User is not a member of this account' }, 404);
  }

  const targetAccountRole = targetMembership.accountRole as AccountRole;
  if (isAccountManager(targetAccountRole)) {
    return c.json({ error: 'Owners and admins have implicit access to every project' }, 409);
  }

  await revokeProjectRole(await actorOf(c, loaded.row.accountId), loaded.row.accountId, projectId, {
    type: 'user',
    id: targetUserId,
  });
  invalidateIamCacheForUser(targetUserId);

  return c.json({ ok: true });
},
);
