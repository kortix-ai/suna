/** Project members: the access roster and per-member role changes and removal. */
import { PROJECT_ACTIONS } from '../../iam';
import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { actorOf } from '../../iam/actor';
import { revokeProjectRole } from '../../iam/assignments';
import { normalizeProjectRole, parseAssignableProjectRole, PROJECT_ROLE_INPUT_ERROR } from '../../iam/roles';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { isAccountManager, roleAllows, type AccountRole, type ProjectRole } from '../access';
import {
  accountRoleMap,
  customRoleBindings,
  foldProjectAccess,
  groupProjectGrants,
  objectGrantRows,
  projectRoleGrants,
} from '../../iam/read-models';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGroupMembers, accountGroups, accountMembers } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';
import {
  grantProjectRole,
  loadProjectForUser,
  resolveUserIdentities,
  parseExpiresAtBody,
  assertProjectCapability,
} from '../lib/access';
import { AccessMemberSchema, AnyObject, projectsApp } from '../lib/app';
import { getAccountMembership } from '../lib/git';
import { readBody } from '../lib/serializers';

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

  // Excludes 'secret' — secrets aren't a member/group-scoped resource surfaced
  // on the access screen (see resource-grants.ts module doc).
  const resourceGrantRows = objectGrants.filter((r) => r.resourceType !== 'secret');
  const groupNameById = new Map(accountGroupRows.map((g) => [g.groupId, g.name] as const));
  // Inner-join semantics, kept: a grant whose group was deleted is not a source.
  const projectGroupRows = groupGrantRows
    .filter((g) => groupNameById.has(g.groupId))
    .map((g) => ({
      groupId: g.groupId,
      groupName: groupNameById.get(g.groupId)!,
      role: g.role,
    }));

  // For every group referenced by ANY channel — project-role grant, custom
  // policy, or resource grant — fetch its members so each can be folded onto
  // the individual users below. One round-trip covering all groups at once.
  const grantGroupIds = projectGroupRows.map((g) => g.groupId);
  const policyGroupIds = customPolicyRows
    .filter((r) => r.principalType === 'group')
    .map((r) => r.principalId);
  const resourceGrantGroupIds = resourceGrantRows
    .filter((r) => r.principalType === 'group')
    .map((r) => r.principalId);
  const allGroupIds = Array.from(new Set([...grantGroupIds, ...policyGroupIds, ...resourceGrantGroupIds]));
  const groupMemberRows = allGroupIds.length
    ? await db
        .select({
          groupId: accountGroupMembers.groupId,
          userId: accountGroupMembers.userId,
        })
        .from(accountGroupMembers)
        .where(inArray(accountGroupMembers.groupId, allGroupIds))
    : [];
  const memberUserIdsByGroup = new Map<string, string[]>();
  for (const m of groupMemberRows) {
    const arr = memberUserIdsByGroup.get(m.groupId) ?? [];
    arr.push(m.userId);
    memberUserIdsByGroup.set(m.groupId, arr);
  }

  // Fold custom-role policies onto individual users (direct member principal,
  // or every current member of a group principal) and, separately, keep the
  // per-group view for `group_access` below.
  type CustomRolePolicyEntry = {
    policy_id: string;
    role_id: string;
    role_key: string;
    role_name: string;
    scope_type: 'project' | 'account';
    source: 'direct' | 'group';
    group_id: string | null;
    group_name: string | null;
    expires_at: string | null;
  };
  const customPoliciesByUser = new Map<string, CustomRolePolicyEntry[]>();
  const customPoliciesByGroup = new Map<string, Omit<CustomRolePolicyEntry, 'source' | 'group_id' | 'group_name'>[]>();
  for (const row of customPolicyRows) {
    const base = {
      policy_id: row.policyId,
      role_id: row.roleId,
      role_key: row.roleKey,
      role_name: row.roleName,
      scope_type: row.scopeType as 'project' | 'account',
      expires_at: row.expiresAt?.toISOString() ?? null,
    };
    if (row.principalType === 'member') {
      const arr = customPoliciesByUser.get(row.principalId) ?? [];
      arr.push({ ...base, source: 'direct', group_id: null, group_name: null });
      customPoliciesByUser.set(row.principalId, arr);
    } else {
      const groupId = row.principalId;
      const groupName = groupNameById.get(groupId) ?? null;
      const groupArr = customPoliciesByGroup.get(groupId) ?? [];
      groupArr.push(base);
      customPoliciesByGroup.set(groupId, groupArr);
      for (const userId of memberUserIdsByGroup.get(groupId) ?? []) {
        const arr = customPoliciesByUser.get(userId) ?? [];
        arr.push({ ...base, source: 'group', group_id: groupId, group_name: groupName });
        customPoliciesByUser.set(userId, arr);
      }
    }
  }

  // Fold resource grants (agent/skill) the same way.
  type ResourceGrantEntry = {
    grant_id: string;
    resource_type: 'agent' | 'skill';
    resource_id: string;
    source: 'direct' | 'group';
    group_id: string | null;
    group_name: string | null;
    expires_at: string | null;
  };
  const resourceGrantsByUser = new Map<string, ResourceGrantEntry[]>();
  const resourceGrantsByGroup = new Map<string, Omit<ResourceGrantEntry, 'source' | 'group_id' | 'group_name'>[]>();
  for (const row of resourceGrantRows) {
    const base = {
      grant_id: row.grantId,
      resource_type: row.resourceType as 'agent' | 'skill',
      resource_id: row.resourceId,
      expires_at: row.expiresAt?.toISOString() ?? null,
    };
    if (row.principalType === 'member') {
      const arr = resourceGrantsByUser.get(row.principalId) ?? [];
      arr.push({ ...base, source: 'direct', group_id: null, group_name: null });
      resourceGrantsByUser.set(row.principalId, arr);
    } else {
      const groupId = row.principalId;
      const groupName = groupNameById.get(groupId) ?? null;
      const groupArr = resourceGrantsByGroup.get(groupId) ?? [];
      groupArr.push(base);
      resourceGrantsByGroup.set(groupId, groupArr);
      for (const userId of memberUserIdsByGroup.get(groupId) ?? []) {
        const arr = resourceGrantsByUser.get(userId) ?? [];
        arr.push({ ...base, source: 'group', group_id: groupId, group_name: groupName });
        resourceGrantsByUser.set(userId, arr);
      }
    }
  }

  // Per-group directory: every group with a project-role grant, a custom-role
  // policy, or a resource grant on this project. Built-in role comes from
  // project_group_grants (V2 bulk-access channel); null when a group reaches
  // this project only via a custom policy or resource grant.
  const groupAccessById = new Map<
    string,
    {
      group_id: string;
      group_name: string | null;
      built_in_role: string | null;
      custom_role_policies: Omit<CustomRolePolicyEntry, 'source' | 'group_id' | 'group_name'>[];
      resource_grants: Omit<ResourceGrantEntry, 'source' | 'group_id' | 'group_name'>[];
    }
  >();
  const getGroupAccessEntry = (groupId: string, groupName: string | null) => {
    let entry = groupAccessById.get(groupId);
    if (!entry) {
      entry = {
        group_id: groupId,
        group_name: groupName,
        built_in_role: null,
        custom_role_policies: [],
        resource_grants: [],
      };
      groupAccessById.set(groupId, entry);
    } else if (groupName && !entry.group_name) {
      entry.group_name = groupName;
    }
    return entry;
  };
  for (const g of projectGroupRows) {
    getGroupAccessEntry(g.groupId, g.groupName).built_in_role = g.role;
  }
  for (const [groupId, policies] of customPoliciesByGroup) {
    getGroupAccessEntry(groupId, groupNameById.get(groupId) ?? null).custom_role_policies = policies;
  }
  for (const [groupId, grants] of resourceGrantsByGroup) {
    getGroupAccessEntry(groupId, groupNameById.get(groupId) ?? null).resource_grants = grants;
  }
  const groupAccess = Array.from(groupAccessById.values());

  // Index: userId → list of { group_id, group_name, role } that contribute.
  type GroupSource = { group_id: string; group_name: string; role: ProjectRole };
  const groupSourcesByUser = new Map<string, GroupSource[]>();
  const grantByGroup = new Map(
    projectGroupRows.map((g) => [g.groupId, g] as const),
  );
  for (const m of groupMemberRows) {
    const grant = grantByGroup.get(m.groupId);
    if (!grant) continue;
    const arr = groupSourcesByUser.get(m.userId) ?? [];
    arr.push({
      group_id: grant.groupId,
      group_name: grant.groupName,
      // Fold a retired stored value (`editor`/`user`/`viewer`) — the access
      // list must never emit a role the API no longer accepts on write.
      role: normalizeProjectRole(grant.role) ?? 'member',
    });
    groupSourcesByUser.set(m.userId, arr);
  }

  const identities = await resolveUserIdentities(identityRows.map((r) => r.userId));
  // Drop shadow members: an account_members row pointing at a user_id that is
  // not a real auth user (e.g. a self-referential row where user_id == the
  // account_id). These have no resolvable email and otherwise render as a bare
  // UUID in the access list.
  const realAccountRows = identityRows.filter((r) => identities.get(r.userId)?.exists !== false);
  const grantsByUser = new Map(grantRows.map((r) => [r.userId, r]));
  const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };

  const members = realAccountRows
    .map((member) => {
      // The floor when a directory row carries no account-scope assignment: the
      // engine denies that principal outright, so `member` is the weakest label
      // that cannot overstate their access.
      const accountRole = (accountRoles.get(member.userId) ?? 'member') as AccountRole;
      const grant = grantsByUser.get(member.userId);
      const projectRole = normalizeProjectRole(grant?.projectRole);
      const groupSources = groupSourcesByUser.get(member.userId) ?? [];

      // ONE fold, shared with the engine's project-role resolution.
      const fold = foldProjectAccess({
        accountRole,
        directRole: projectRole,
        groupSources,
      });

      return {
        user_id: member.userId,
        email: identities.get(member.userId)?.email ?? null,
        account_role: accountRole,
        project_role: projectRole,
        effective_project_role: fold.effective_project_role,
        has_implicit_access: isAccountManager(accountRole),
        /** What ultimately decided the effective role. UI labels with
         *  it: "Manager (account admin)" vs "Member (via Engineering)". */
        effective_source: fold.effective_source,
        /** Every group attachment that includes this user. Lets the UI
         *  list multi-source access ("Manager via Engineering + Member
         *  via Viewers") without further API calls. */
        group_sources: fold.group_sources,
        joined_at: member.joinedAt.toISOString(),
        granted_by: grant?.grantedBy ?? null,
        granted_at: grant?.createdAt?.toISOString() ?? null,
        updated_at: grant?.updatedAt?.toISOString() ?? null,
        /** Auto-revoke timestamp for the DIRECT grant. NULL = permanent.
         *  Group-derived expiries are surfaced per-source separately
         *  (not yet wired into group_sources — follow-up). */
        expires_at: grant?.expiresAt?.toISOString() ?? null,
        /** Custom (IAM v1) role policies bound to this user, direct or via a
         *  group they belong to — additive to `role`/`sources`, never folded
         *  into `effective_project_role`. */
        custom_role_policies: customPoliciesByUser.get(member.userId) ?? [],
        /** IAM v2 per-resource (agent/skill) grants scoped to this user,
         *  direct or via a group they belong to. */
        resource_grants: resourceGrantsByUser.get(member.userId) ?? [],
      };
    })
    .sort((a, b) => {
      const roleDelta = rank[a.account_role] - rank[b.account_role];
      if (roleDelta !== 0) return roleDelta;
      return (a.email ?? a.user_id).localeCompare(b.email ?? b.user_id);
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

  const body = await readBody(c);
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
