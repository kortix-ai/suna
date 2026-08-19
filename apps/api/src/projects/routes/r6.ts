import { buildInviteUrl, isInviteEmailConfigured, sendAccountInviteEmail } from '../../accounts/email';
import { PROJECT_ACTIONS, authorize } from '../../iam';
import { assertAgentScope } from '../../iam/agent-scope';
import { invalidateIamCacheForUser } from '../../iam/cache-invalidation';
import { actorOf } from '../../iam/actor';
import { normalizeProjectRole, parseAssignableProjectRole, PROJECT_ROLE_INPUT_ERROR } from '../../iam/role-perms';
import { auth, errors, json } from '../../openapi';
import { db } from '../../shared/db';
import { lookupUserIdByEmail } from '../../shared/users';
import { foldEffectiveProjectAccess, isAccountManager, roleAllows, type AccountRole, type ProjectRole } from '../access';
import { createRoute, z } from '@hono/zod-openapi';
import { accountGroupMembers, accountGroups, accountInvitations, accountMembers, accounts, projectAccessRequests, projectGroupGrants, projectMembers, projects } from '@kortix/db';
import { iamPolicies, iamRoles } from '@kortix/db';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { ensureOrgMembership, grantProjectRole, loadProjectForUser, lookupEmailsByUserIds, resolveUserIdentities, parseExpiresAtBody, assertProjectCapability } from '../lib/access';
import { listResourceGrants } from '../../iam/resource-grants';
import { notifyProjectAccessRequestManagers } from '../lib/access-requests';
import {
  AccessMemberSchema,
  AnyObject,
  SandboxProviderPatchResultSchema,
  SandboxProviderTransitionStateSchema,
  projectsApp,
} from '../lib/app';
import { getAccountMembership } from '../lib/git';
import { readBody, serializeProject } from '../lib/serializers';
import { metadataClearSubtreeKey, metadataMerge, metadataMergeSubtree } from '../lib/metadata-merge';
import { isFeatureFlagKey } from '../../feature-flags/registry';
import { runFeatureFlagToggleEffects } from '../../feature-flags/toggle-effects';
import { deleteManagedProjectRepo } from '../lib/project-deletion';
import {
  requestProviderTransition,
  readPublicProjectTransitionState,
  ProviderTransitionError,
} from '../provider-transition/provider-transition-service';

function serializeProjectAccessRequest(row: typeof projectAccessRequests.$inferSelect) {
  return {
    request_id: row.requestId,
    account_id: row.accountId,
    project_id: row.projectId,
    requester_user_id: row.requesterUserId,
    requester_email: row.requesterEmail,
    message: row.message ?? null,
    status: row.status,
    reviewed_by: row.reviewedBy ?? null,
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

const ONBOARDING_USE_CASES = new Set([
  'sales',
  'support',
  'marketing',
  'engineering',
  'finance_ops',
  'hr_recruiting',
  'other',
]);
const ONBOARDING_COMPANY_SIZES = new Set(['1-10', '11-50', '51-200', '201-1000', '1000+']);

/**
 * Allowlist the guided-onboarding profile. Returns `null` when there is nothing
 * to write, so the caller can skip the UPDATE entirely rather than issue a
 * no-op that still bumps `updated_at`.
 *
 * Unknown keys and out-of-range values are DROPPED, not rejected. This is
 * best-effort survey capture fired as the user answers each question — a client
 * that sends a field we retired must not break somebody's onboarding.
 */
function pickOnboardingProfile(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const out: Record<string, string> = {};

  if (typeof raw.use_case === 'string' && ONBOARDING_USE_CASES.has(raw.use_case)) {
    out.use_case = raw.use_case;
  }
  if (typeof raw.company_size === 'string' && ONBOARDING_COMPANY_SIZES.has(raw.company_size)) {
    out.company_size = raw.company_size;
  }
  if (typeof raw.company_domain === 'string') {
    // 253 is the maximum length of a DNS name.
    const domain = raw.company_domain.trim().toLowerCase().slice(0, 253);
    if (domain) out.company_domain = domain;
  }

  return Object.keys(out).length > 0 ? out : null;
}

projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/onboarding',
    tags: ['projects'],
    summary: 'PATCH /:projectId/onboarding',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const body = await readBody(c);
  const loaded = await loadProjectForUser(c, projectId, 'write');
  if (!loaded) return c.json({ error: 'Not found' }, 404);

  // Two independent writes share this route. `completed` is a TOP-LEVEL
  // lifecycle flag; `profile` is a NESTED object written answer-by-answer as
  // the user moves through the onboarding wizard. A request carries one or the
  // other, never both.
  const profile = pickOnboardingProfile(body.profile);

  let metadataExpr;
  if (profile) {
    // Nested → metadataMergeSubtree, which re-reads `metadata->'onboarding'`
    // inside the statement. A top-level `||` of the whole sub-object would let
    // two concurrent writers into DIFFERENT sub-keys lose each other's update
    // one level down.
    metadataExpr = metadataMergeSubtree('onboarding', profile);
  } else if ('completed' in body) {
    // FIX-J: SQL-side atomic merge of ONLY `onboarding_completed_at` (set /
    // delete) so this write can't revert a routing pin written concurrently.
    metadataExpr =
      body.completed === true
        ? metadataMerge({ onboarding_completed_at: new Date().toISOString() })
        : metadataMerge({}, ['onboarding_completed_at']);
  } else {
    // Nothing survived the allowlist and no completion flag was sent. Return
    // the project unchanged rather than issue a no-op UPDATE that would still
    // bump `updated_at` and reorder project lists for no reason.
    return c.json(
      serializeProject(loaded.row, {
        projectRole: loaded.projectRole,
        effectiveRole: loaded.effectiveRole,
      }),
    );
  }

  const [row] = await db
    .update(projects)
    .set({ metadata: metadataExpr, updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();

  if (!row || row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  return c.json(serializeProject(row, {
    projectRole: loaded.projectRole,
    effectiveRole: loaded.effectiveRole,
  }));
},
);

// DELETE /v1/projects/:projectId

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}',
    tags: ['projects'],
    summary: 'DELETE /:projectId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        query: z.object({ purge: z.enum(['true', 'false']).optional() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 502),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Deletion is admin-only. The floor `member` role explicitly excludes
  // project.delete; loadProjectForUser('manage') would otherwise let
  // members through via project.write.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_DELETE);

  // Archiving is recoverable by default. Only an explicit purge permanently
  // deletes a Kortix-managed upstream; user-connected/BYO repositories are
  // always left untouched. Delete before hiding the project so provider
  // failures remain visible and retryable.
  const purge = c.req.query('purge') === 'true';
  let repoDeleted = false;
  if (purge) {
    try {
      repoDeleted = await deleteManagedProjectRepo(loaded.row);
    } catch (error) {
      console.error(`[projects] failed to delete managed repo for ${projectId}:`, error);
      return c.json({ error: 'Failed to delete managed project repository' }, 502);
    }
  }

  const [row] = await db
    .update(projects)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();

  if (!row) return c.json({ error: 'Not found' }, 404);
  return c.json({ ok: true, archived: true, repo_deleted: repoDeleted });
},
);

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

  const [accountRows, grantRows, projectGroupRows, customPolicyRows, resourceGrantRowsRaw, accountGroupRows] =
    await Promise.all([
      db
        .select({
          userId: accountMembers.userId,
          accountRole: accountMembers.accountRole,
          joinedAt: accountMembers.joinedAt,
        })
        .from(accountMembers)
        .where(eq(accountMembers.accountId, loaded.row.accountId)),
      db
        .select({
          userId: projectMembers.userId,
          projectRole: projectMembers.projectRole,
          grantedBy: projectMembers.grantedBy,
          createdAt: projectMembers.createdAt,
          updatedAt: projectMembers.updatedAt,
          expiresAt: projectMembers.expiresAt,
        })
        .from(projectMembers)
        .where(eq(projectMembers.projectId, loaded.row.projectId)),
      // V2 group grants attached to this project. Each row lifts everyone in
      // the group to at least the grant's role on this project. Per-user
      // membership lookup happens below; we fetch group → role mapping +
      // name in one shot here so we can label sources on the response.
      db
        .select({
          groupId: projectGroupGrants.groupId,
          groupName: accountGroups.name,
          role: projectGroupGrants.role,
        })
        .from(projectGroupGrants)
        .innerJoin(accountGroups, eq(accountGroups.groupId, projectGroupGrants.groupId))
        .where(eq(projectGroupGrants.projectId, loaded.row.projectId)),
      // IAM v1 custom-role policies bound to this project (scope_type='project',
      // scope_id=this project) or account-wide (scope_type='account' — every
      // project on this account, scope_id is NULL for that row shape; the
      // account is already pinned by the accountId column, mirroring the
      // engine-v2 actor-resolution query above). member/group principals only
      // — a 'token' principal is a service account, not a human to fold onto
      // the members list.
      db
        .select({
          policyId: iamPolicies.policyId,
          principalType: iamPolicies.principalType,
          principalId: iamPolicies.principalId,
          roleId: iamPolicies.roleId,
          roleKey: iamRoles.key,
          roleName: iamRoles.name,
          scopeType: iamPolicies.scopeType,
          expiresAt: iamPolicies.expiresAt,
        })
        .from(iamPolicies)
        .innerJoin(iamRoles, eq(iamRoles.roleId, iamPolicies.roleId))
        .where(
          and(
            eq(iamPolicies.accountId, loaded.row.accountId),
            inArray(iamPolicies.principalType, ['member', 'group']),
            or(
              and(eq(iamPolicies.scopeType, 'project'), eq(iamPolicies.scopeId, loaded.row.projectId)),
              eq(iamPolicies.scopeType, 'account'),
            ),
          ),
        ),
      // IAM v2 per-resource (agent/skill) grants for this project. Excludes
      // 'secret' — secrets aren't a member/group-scoped resource surfaced on
      // the access screen (see resource-grants.ts module doc).
      listResourceGrants(loaded.row.projectId),
      // All groups on this account, for name resolution below. Custom-role
      // policies and resource grants can target a group that never got a
      // project_group_grants row, so `projectGroupRows`'s name join above
      // doesn't cover it — this is the superset lookup.
      db
        .select({ groupId: accountGroups.groupId, name: accountGroups.name })
        .from(accountGroups)
        .where(eq(accountGroups.accountId, loaded.row.accountId)),
    ]);

  const resourceGrantRows = resourceGrantRowsRaw.filter((r) => r.resourceType !== 'secret');
  const groupNameById = new Map(accountGroupRows.map((g) => [g.groupId, g.name] as const));

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

  const identities = await resolveUserIdentities(accountRows.map((r) => r.userId));
  // Drop shadow members: an account_members row pointing at a user_id that is
  // not a real auth user (e.g. a self-referential row where user_id == the
  // account_id). These have no resolvable email and otherwise render as a bare
  // UUID in the access list.
  const realAccountRows = accountRows.filter((r) => identities.get(r.userId)?.exists !== false);
  const grantsByUser = new Map(grantRows.map((r) => [r.userId, r]));
  const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };

  const members = realAccountRows
    .map((member) => {
      const accountRole = member.accountRole as AccountRole;
      const grant = grantsByUser.get(member.userId);
      const projectRole = normalizeProjectRole(grant?.projectRole);
      const groupSources = groupSourcesByUser.get(member.userId) ?? [];

      // Pure fold — see projects/access.ts for the precedence rules.
      const fold = foldEffectiveProjectAccess({
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

// POST /v1/projects/:projectId/access-requests
// Lets a signed-in user with a project link ask the project's managers for
// access without mounting the normal project shell (which would otherwise fan
// out into many 403s). Mirrors the Figma-style "Request access" affordance.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/access-requests',
    tags: ['access'],
    summary: 'POST /:projectId/access-requests',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'Existing access request or access state'),
        201: json(z.any(), 'Access request created'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const requesterEmail = ((c.get('userEmail') as string | undefined) ?? '').trim().toLowerCase();
  const body = await readBody(c);
  const messageRaw = typeof body.message === 'string' ? body.message.trim() : '';
  const message = messageRaw ? messageRaw.slice(0, 2000) : null;

  const [project] = await db
    .select({
      accountId: projects.accountId,
      projectId: projects.projectId,
      status: projects.status,
    })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project || project.status === 'archived') return c.json({ error: 'Not found' }, 404);

  const membership = await getAccountMembership(userId, project.accountId);
  if (membership) {
    // The one route that runs the engine EXPECTING a denial — "I can't get in,
    // let me ask" (routes.md §5.14). It must stay non-throwing.
    const verdict = await authorize(await actorOf(c, project.accountId), PROJECT_ACTIONS.PROJECT_READ, {
      type: 'project',
      id: projectId,
    });
    if (verdict.allowed) {
      return c.json({ status: 'already_has_access', project_id: projectId });
    }
  }

  const [existing] = await db
    .select()
    .from(projectAccessRequests)
    .where(and(
      eq(projectAccessRequests.projectId, projectId),
      eq(projectAccessRequests.requesterUserId, userId),
      eq(projectAccessRequests.status, 'pending'),
    ))
    .limit(1);

  if (existing) {
    return c.json({ status: 'pending', request: serializeProjectAccessRequest(existing) });
  }

  const [created] = await db
    .insert(projectAccessRequests)
    .values({
      accountId: project.accountId,
      projectId,
      requesterUserId: userId,
      requesterEmail: requesterEmail || userId,
      message,
    })
    .returning();

  await notifyProjectAccessRequestManagers({
    accountId: project.accountId,
    projectId,
    requesterUserId: userId,
    requesterEmail: created.requesterEmail,
    message,
  });

  return c.json({ status: 'created', request: serializeProjectAccessRequest(created) }, 201);
},
);

// GET /v1/projects/:projectId/access-requests
// Managers review pending "request access" asks from the Members screen.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/access-requests',
    tags: ['access'],
    summary: 'GET /:projectId/access-requests',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'Pending access requests'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  // Floor is 'read' (project membership); the real gate is the members.manage
  // leaf below, so a custom role granting ONLY members.manage (no project.write)
  // works, and — matching the sibling approve/reject routes — a plain member
  // (project.write but not members.manage) can't list pending access requests.
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const rows = await db
    .select()
    .from(projectAccessRequests)
    .where(and(
      eq(projectAccessRequests.projectId, projectId),
      eq(projectAccessRequests.status, 'pending'),
    ))
    .orderBy(desc(projectAccessRequests.createdAt));

  return c.json({ requests: rows.map(serializeProjectAccessRequest) });
},
);

// POST /v1/projects/:projectId/access-requests/:requestId/approve

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/access-requests/{requestId}/approve',
    tags: ['access'],
    summary: 'POST /:projectId/access-requests/:requestId/approve',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), requestId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
      200: json(z.any(), 'Access request approved'),
        ...errors(400, 404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const requestId = c.req.param('requestId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Approving an access request grants a project role to the requester —
  // membership management, NOT plain write. loadProjectForUser('manage') only
  // maps to project.write, so without this a non-manager could approve
  // requests and even hand out the 'manager' role. Gate on members.manage.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const body = await readBody(c);
  const role = body.role === undefined ? 'member' : parseAssignableProjectRole(body.role);
  if (!role) return c.json({ error: PROJECT_ROLE_INPUT_ERROR }, 400);

  const [request] = await db
    .select()
    .from(projectAccessRequests)
    .where(and(
      eq(projectAccessRequests.requestId, requestId),
      eq(projectAccessRequests.projectId, projectId),
    ))
    .limit(1);
  if (!request) return c.json({ error: 'Not found' }, 404);
  if (request.status !== 'pending') {
    return c.json({ error: 'Access request has already been reviewed' }, 409);
  }

  const targetAccountRole = await ensureOrgMembership(
    loaded.row.accountId,
    request.requesterUserId,
  );

  if (!isAccountManager(targetAccountRole)) {
    await grantProjectRole({
      accountId: loaded.row.accountId,
      projectId,
      userId: request.requesterUserId,
      role,
      grantedBy: loaded.userId,
    });
  }

  const [updated] = await db
    .update(projectAccessRequests)
    .set({
      status: 'approved',
      reviewedBy: loaded.userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(projectAccessRequests.requestId, requestId))
    .returning();

  return c.json({
    request: serializeProjectAccessRequest(updated),
    member: {
      user_id: request.requesterUserId,
      email: request.requesterEmail,
      account_role: targetAccountRole,
      project_role: isAccountManager(targetAccountRole) ? null : role,
      effective_project_role: isAccountManager(targetAccountRole) ? 'manager' : role,
      has_implicit_access: isAccountManager(targetAccountRole),
    },
  });
},
);

// POST /v1/projects/:projectId/access-requests/:requestId/reject

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/access-requests/{requestId}/reject',
    tags: ['access'],
    summary: 'POST /:projectId/access-requests/:requestId/reject',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), requestId: z.string() }),
      },
    responses: {
      200: json(z.any(), 'Access request rejected'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const requestId = c.req.param('requestId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Reviewing an access request is membership management — gate on
  // members.manage (loadProjectForUser('manage') only enforces project.write).
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const [request] = await db
    .select()
    .from(projectAccessRequests)
    .where(and(
      eq(projectAccessRequests.requestId, requestId),
      eq(projectAccessRequests.projectId, projectId),
    ))
    .limit(1);
  if (!request) return c.json({ error: 'Not found' }, 404);
  if (request.status !== 'pending') {
    return c.json({ error: 'Access request has already been reviewed' }, 409);
  }

  const [updated] = await db
    .update(projectAccessRequests)
    .set({
      status: 'rejected',
      reviewedBy: loaded.userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(projectAccessRequests.requestId, requestId))
    .returning();

  return c.json({ request: serializeProjectAccessRequest(updated) });
},
);

// PUT /v1/projects/:projectId/access/:userId
// POST /v1/projects/:projectId/access/invite
// Invite a person to a project by email: looks up their Kortix account, ensures
// they're an org member (creating a 'member' org row if needed), then grants the
// project role. Account managers get implicit project access (no explicit grant).

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/access/invite',
    tags: ['access'],
    summary: 'POST /:projectId/access/invite',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(400, 404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  // Inviting a member grants project access — members.manage, not plain write.
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const body = await readBody(c);
  const email = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase();
  const role = parseAssignableProjectRole(body.role);
  if (!email) return c.json({ error: 'email is required' }, 400);
  if (!role) return c.json({ error: PROJECT_ROLE_INPUT_ERROR }, 400);
  const expires = parseExpiresAtBody(body.expires_at);
  if (!expires.ok) return c.json({ error: expires.error }, 400);

  const targetUserId = await lookupUserIdByEmail(email);
  if (!targetUserId) {
    // No Kortix user yet. Upsert an account invitation carrying a
    // bootstrap_grant so when they accept, they're added to the org
    // AND granted the project role in one step — no separate "invite
    // to org, then invite to project" dance. The unique index on
    // (account_id, email) makes this idempotent; re-inviting the
    // same email to a second project merges the grants list.
    const bootstrap = {
      project_id: projectId,
      role,
      ...(expires.value
        ? { expires_at: expires.value.toISOString() }
        : {}),
    };
    // Wrap the find-or-create in a transaction with SELECT … FOR UPDATE
    // so two concurrent admins inviting the same email can't both see
    // the same pre-state and produce a last-write-wins merge that
    // drops one of their grants. The lock blocks the second admin's
    // SELECT until the first transaction commits; the second admin
    // then sees the first's grant and merges on top of it.
    const inviteId = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          inviteId: accountInvitations.inviteId,
          bootstrapGrants: accountInvitations.bootstrapGrants,
        })
        .from(accountInvitations)
        .where(
          and(
            eq(accountInvitations.accountId, loaded.row.accountId),
            sql`lower(${accountInvitations.email}) = ${email}`,
            isNull(accountInvitations.acceptedAt),
          ),
        )
        .for('update')
        .limit(1);
      if (existing) {
        // Merge bootstrap grants by project_id (later wins on role).
        const merged = [...(existing.bootstrapGrants ?? [])];
        const idx = merged.findIndex((g) => 'project_id' in g && g.project_id === projectId);
        if (idx >= 0) merged[idx] = bootstrap;
        else merged.push(bootstrap);
        await tx
          .update(accountInvitations)
          .set({ bootstrapGrants: merged })
          .where(eq(accountInvitations.inviteId, existing.inviteId));
        return existing.inviteId;
      }
      const [created] = await tx
        .insert(accountInvitations)
        .values({
          accountId: loaded.row.accountId,
          email,
          invitedBy: loaded.userId,
          initialRole: 'member',
          bootstrapGrants: [bootstrap],
        })
        .returning({ inviteId: accountInvitations.inviteId });
      return created.inviteId;
    });

    // Fire the invite email — same transport + template as account-level
    // invites, framed around this project. Fire-and-forget: the invitation row
    // already exists and we return the invite_url regardless, so we don't block
    // the response on the email provider (its 10s timeout was stacking onto the request).
    // send() never throws (it returns a result object), but guard the promise
    // anyway so a transport-layer rejection can't surface as unhandled.
    const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
    const [accountRow] = await db
      .select({ name: accounts.name })
      .from(accounts)
      .where(eq(accounts.accountId, loaded.row.accountId))
      .limit(1);
    const emailConfigured = isInviteEmailConfigured();
    if (emailConfigured) {
      void sendAccountInviteEmail({
        email,
        accountName: accountRow?.name ?? 'Kortix',
        inviterEmail: callerEmail,
        inviteId,
        role,
        projectName: loaded.row.name,
      }).catch((err) => {
        console.warn('[projects/invite] invite email send failed:', (err as Error).message);
      });
    }

    return c.json(
      {
        status: 'invited',
        email,
        invite_id: inviteId,
        project_role: role,
        invite_url: buildInviteUrl(inviteId),
        // Optimistic: send is queued, not awaited. When delivery isn't wired up
        // we know synchronously it'll be skipped, so report that honestly.
        email_sent: emailConfigured,
        email_skip_reason: emailConfigured ? null : 'email_not_configured',
        message: emailConfigured
          ? `No Kortix account for that email yet — an invitation email has been sent. They'll land on this project as ${role} when they sign up.`
          : `No Kortix account for that email yet — invitation created. Share the invite link with them; they'll land on this project as ${role} when they sign up.`,
      },
      201,
    );
  }

  const targetAccountRole = await ensureOrgMembership(loaded.row.accountId, targetUserId);
  if (isAccountManager(targetAccountRole)) {
    return c.json({
      user_id: targetUserId,
      email,
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
    email,
    account_role: targetAccountRole,
    project_role: role,
    effective_project_role: role,
    has_implicit_access: false,
  });
},
);

// GET /v1/projects/:projectId/access/pending-invites
// Lists pending account_invitations whose bootstrap_grants target this
// project. Surfaces the "I invited someone whose email doesn't have a
// Kortix account yet" intermediate state — without this the UI looks
// the same before and after a successful invite, leaving the inviter
// to wonder if anything happened.
//
// Restricted to project managers — viewers don't need to see who's
// queued up for membership.

projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/access/pending-invites',
    tags: ['access'],
    summary: 'GET /:projectId/access/pending-invites',
    ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  // JSONB containment check (`@>`) finds invitations whose grants array
  // contains an entry with this project_id. Includes expired invites in
  // the result with a flag so the UI can show them dimmed + a "Resend"
  // affordance later if we want it (out of scope for now — just hide).
  const rows = await db
    .select({
      inviteId: accountInvitations.inviteId,
      email: accountInvitations.email,
      initialRole: accountInvitations.initialRole,
      invitedBy: accountInvitations.invitedBy,
      createdAt: accountInvitations.createdAt,
      expiresAt: accountInvitations.expiresAt,
      bootstrapGrants: accountInvitations.bootstrapGrants,
    })
    .from(accountInvitations)
    .where(
      and(
        eq(accountInvitations.accountId, loaded.row.accountId),
        isNull(accountInvitations.acceptedAt),
        sql`${accountInvitations.bootstrapGrants} @> ${JSON.stringify([{ project_id: projectId }])}::jsonb`,
      ),
    );

  // Resolve inviter emails in one shot (one auth.admin call per inviter
  // since the Supabase helper has no batch API; the set is tiny in
  // practice — usually 1 or 2 distinct admins).
  const inviterIds = Array.from(
    new Set(rows.map((r) => r.invitedBy).filter((v): v is string => !!v)),
  );
  const inviterEmails = await lookupEmailsByUserIds(inviterIds);

  const now = Date.now();
  const items = rows
    .map((r) => {
      const grant = (r.bootstrapGrants ?? []).find(
        (g) => 'project_id' in g && g.project_id === projectId,
      );
      // Defensive — the WHERE already filtered for project_id, but the
      // type system doesn't know that, and a corrupt row shouldn't 500.
      if (!grant || !('project_id' in grant)) return null;
      return {
        invite_id: r.inviteId,
        email: r.email,
        // Normalize a legacy `viewer`/`user` grant to `member` so the API never
        // emits a retired role.
        project_role: normalizeProjectRole(grant.role) ?? 'member',
        expires_at: grant.expires_at ?? null,
        invited_by_email: r.invitedBy ? (inviterEmails.get(r.invitedBy) ?? null) : null,
        created_at: r.createdAt.toISOString(),
        invite_expires_at: r.expiresAt.toISOString(),
        invite_expired: r.expiresAt.getTime() <= now,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return c.json({ pending: items });
},
);

// DELETE /v1/projects/:projectId/access/pending-invites/:inviteId
// Removes this project's bootstrap_grant from a pending invitation. If
// that was the only grant AND the invitation is the auto-created
// "member" variety (always how project /access/invite creates them), the
// whole invitation row goes away — the user simply isn't being invited
// anywhere anymore. If the inviter had set a higher initial_role
// (admin/owner) or other project grants remain, we keep the invitation
// and just strip this project from it.

projectsApp.openapi(
  createRoute({
    method: 'delete',
    path: '/{projectId}/access/pending-invites/{inviteId}',
    tags: ['access'],
    summary: 'DELETE /:projectId/access/pending-invites/:inviteId',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), inviteId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const inviteId = c.req.param('inviteId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const [invite] = await db
    .select({
      inviteId: accountInvitations.inviteId,
      accountId: accountInvitations.accountId,
      initialRole: accountInvitations.initialRole,
      acceptedAt: accountInvitations.acceptedAt,
      bootstrapGrants: accountInvitations.bootstrapGrants,
    })
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite || invite.accountId !== loaded.row.accountId) {
    return c.json({ error: 'Invitation not found' }, 404);
  }
  if (invite.acceptedAt) {
    return c.json({ error: 'Invitation has already been accepted' }, 409);
  }

  const remaining = (invite.bootstrapGrants ?? []).filter(
    (g) => !('project_id' in g) || g.project_id !== projectId,
  );

  // Auto-cancel the whole invitation if (a) nothing else is being
  // granted AND (b) the original invite was for a plain member (which
  // is the only role our project invite endpoint creates). Anything
  // higher-tier must have been set deliberately at the account level
  // and shouldn't be silently dropped.
  if (remaining.length === 0 && invite.initialRole === 'member') {
    await db
      .delete(accountInvitations)
      .where(eq(accountInvitations.inviteId, inviteId));
    return c.json({ ok: true, invitation_cancelled: true });
  }

  await db
    .update(accountInvitations)
    .set({ bootstrapGrants: remaining })
    .where(eq(accountInvitations.inviteId, inviteId));

  return c.json({ ok: true, invitation_cancelled: false });
},
);

// POST /v1/projects/:projectId/access/pending-invites/:inviteId/resend
// Re-sends the project invite email and refreshes the invitation's 14-day
// expiry. Mirrors the account-level resend, but re-frames the email around
// this project and reads the role from the bootstrap grant for this project.

projectsApp.openapi(
  createRoute({
    method: 'post',
    path: '/{projectId}/access/pending-invites/{inviteId}/resend',
    tags: ['access'],
    summary: 'POST /:projectId/access/pending-invites/:inviteId/resend',
    ...auth,
      request: {
        params: z.object({ projectId: z.string(), inviteId: z.string() }),
      },
    responses: {
        200: json(z.any(), 'OK'),
        ...errors(404, 409),
    },
  }),
  async (c: any) => {
  const projectId = c.req.param('projectId');
  const inviteId = c.req.param('inviteId');
  const loaded = await loadProjectForUser(c, projectId, 'manage');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE);

  const [invite] = await db
    .select({
      inviteId: accountInvitations.inviteId,
      accountId: accountInvitations.accountId,
      email: accountInvitations.email,
      acceptedAt: accountInvitations.acceptedAt,
      bootstrapGrants: accountInvitations.bootstrapGrants,
    })
    .from(accountInvitations)
    .where(eq(accountInvitations.inviteId, inviteId))
    .limit(1);

  if (!invite || invite.accountId !== loaded.row.accountId) {
    return c.json({ error: 'Invitation not found' }, 404);
  }
  if (invite.acceptedAt) {
    return c.json({ error: 'Invitation has already been accepted' }, 409);
  }
  const grant = (invite.bootstrapGrants ?? []).find(
    (g) => 'project_id' in g && g.project_id === projectId,
  );
  if (!grant || !('project_id' in grant)) {
    return c.json({ error: 'Invitation does not target this project' }, 404);
  }

  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  await db
    .update(accountInvitations)
    .set({ expiresAt })
    .where(eq(accountInvitations.inviteId, inviteId));

  const callerEmail = (c.get('userEmail') as string | undefined) ?? null;
  const [accountRow] = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.accountId, loaded.row.accountId))
    .limit(1);
  const delivery = await sendAccountInviteEmail({
    email: invite.email,
    accountName: accountRow?.name ?? 'Kortix',
    inviterEmail: callerEmail,
    inviteId: invite.inviteId,
    role: grant.role,
    projectName: loaded.row.name,
  });

  return c.json({
    ok: true,
    expires_at: expiresAt.toISOString(),
    invite_url: buildInviteUrl(invite.inviteId),
    email_sent: delivery.ok === true,
    email_skip_reason:
      delivery.ok === false && 'reason' in delivery ? delivery.reason : null,
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
    await db
      .delete(projectMembers)
      .where(and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, targetUserId),
      ));
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

  await db
    .delete(projectMembers)
    .where(and(
      eq(projectMembers.projectId, projectId),
      eq(projectMembers.userId, targetUserId),
    ));
  invalidateIamCacheForUser(targetUserId);

  return c.json({ ok: true });
},
);

// ─── Project group grants (IAM V2 bulk-access channel) ────────────────────
//
// A row in project_group_grants attaches an account_group to a project
// with a chosen project_role. Every member of the group inherits that
// role on that project. These routes work for both V1 and V2 accounts —
// V1 just ignores the rows because V1's engine reads from iam_policies.

// PATCH /:projectId/features (canonical) and /:projectId/experimental
// (compat alias — published SDKs call it) — set or clear a per-project
// feature-flag override. Auth-first (matches the other project routes), then
// validate the body — so the body schema stays permissive (AnyObject) and the
// handler returns the precise 400/403/404.
const patchFeatureFlagHandler = async (c: any) => {
  const projectId = c.req.param('projectId');
  // Strict body: malformed JSON is a client error, not an empty object —
  // readBody() would swallow the parse failure and mis-report "unknown flag".
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Request body must be a JSON object' }, 400);
  }
  const feature = body.feature;
  const enabled = body.enabled;
  // Floor 'read' (membership); project.customize.write is the human gate below
  // (was 'manage' → project.write, so unchecking customize.write did nothing).
  const loaded = await loadProjectForUser(c, projectId, 'read');
  if (!loaded) return c.json({ error: 'Not found' }, 404);
  await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
  // Per-agent gate: toggling feature flags is project config. A scoped agent
  // token must hold project.customize.write (no-op for humans/PATs).
  assertAgentScope(c, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
  if (!isFeatureFlagKey(feature)) {
    return c.json({ error: `Unknown feature flag '${feature}'` }, 400);
  }
  if (enabled !== null && typeof enabled !== 'boolean') {
    return c.json({ error: 'enabled must be a boolean or null' }, 400);
  }
  // Archived projects are read-only: reject BEFORE the write. The old order
  // (update, then 404 on archived) committed the metadata mutation anyway.
  if (loaded.row.status === 'archived') return c.json({ error: 'Not found' }, 404);
  // FIX-J: `experimental` is a NESTED object, so a whole-object `||` merge of it
  // would lose an update one level down when two flags are toggled
  // concurrently. Re-read + merge the CURRENT `experimental` sub-object in-SQL:
  // set writes only `experimental.<feature>`; clear removes it (dropping the
  // whole `experimental` key once the last override is gone). The metadata key
  // name `experimental` is a stable storage detail. Every write preserves the
  // routing pin.
  const metadataExpr =
    enabled === null
      ? metadataClearSubtreeKey('experimental', feature)
      : metadataMergeSubtree('experimental', { [feature]: enabled });
  const [row] = await db
    .update(projects)
    .set({ metadata: metadataExpr, updatedAt: new Date() })
    .where(eq(projects.projectId, projectId))
    .returning();
  if (!row) return c.json({ error: 'Not found' }, 404);
  // Convergence work (connector materialization, sandbox env fan-out) runs
  // behind the response; runFeatureFlagToggleEffects retries once and logs
  // failures at error level. See feature-flags/toggle-effects.ts.
  void runFeatureFlagToggleEffects({
    key: feature,
    projectId,
    accountId: row.accountId,
    metadata: row.metadata,
  });
  return c.json(serializeProject(row, { projectRole: loaded.projectRole, effectiveRole: loaded.effectiveRole }));
};

for (const path of ['/{projectId}/features', '/{projectId}/experimental'] as const) {
  projectsApp.openapi(
    createRoute({
      method: 'patch',
      path,
      tags: ['projects'],
      summary:
        path === '/{projectId}/features'
          ? 'Set or clear a per-project feature-flag override'
          : 'Set or clear a per-project feature-flag override (deprecated alias of /features)',
      ...auth,
      request: {
        params: z.object({ projectId: z.string() }),
        body: { content: { 'application/json': { schema: AnyObject } } },
      },
      responses: {
        200: json(AnyObject, 'Updated project (with feature-flag state)'),
        ...errors(400, 401, 403, 404),
      },
    }),
    patchFeatureFlagHandler,
  );
}

// PATCH /:projectId/sandbox-provider — set or clear the per-project sandbox-provider
// pin (Customize → Settings). The value must be an ENABLED provider
// (in ALLOWED_SANDBOX_PROVIDERS and with its API key configured), or null/'' to clear
// (follow the platform default/distribution). Bypasses the distribution weights by
// design — pin a project to platinum even when platinum's weight is 0. Same auth as
// the experimental toggle (project 'manage' + project.customize.write for agents).
projectsApp.openapi(
  createRoute({
    method: 'patch',
    path: '/{projectId}/sandbox-provider',
    tags: ['projects'],
    summary: 'Set or clear the per-project sandbox provider override',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
      body: { content: { 'application/json': { schema: AnyObject } } },
    },
    responses: {
      // FIX-L: EITHER the updated project (immediate) OR a preparation object
      // (prepare branch), discriminated by `kind`. Both are HTTP 200 (clients may
      // hard-check === 200); `kind` disambiguates without shape-sniffing.
      200: json(SandboxProviderPatchResultSchema, 'Updated project or preparation'),
      ...errors(400, 401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const body = await readBody(c);
    const raw = body.provider ?? body.sandbox_provider;
    // Floor 'read'; project.customize.write is the human gate below (was
    // 'manage' → project.write, so unchecking customize.write did nothing here).
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    await assertProjectCapability(c, loaded.userId, loaded.row.accountId, projectId, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);
    assertAgentScope(c, PROJECT_ACTIONS.PROJECT_CUSTOMIZE_WRITE);

    // Route the change through the durable prepare→verify→activate workflow.
    // Switching to a safe target (null clear, the platform-default provider, or
    // the already-active provider) is applied immediately and returns the
    // updated project (back-compat). Switching to a DIFFERENT enabled provider
    // (the Daytona→Platinum case) does NOT flip the active provider now — it
    // records a durable transition, keeps the source active for new sessions,
    // and returns a PREPARATION object the UI polls until the target image is
    // built + verified, then activated.
    try {
      const result = await requestProviderTransition({ projectId, targetRaw: raw });
      if (result.kind === 'immediate') {
        if (result.projectRow.status === 'archived') return c.json({ error: 'Not found' }, 404);
        // FIX-L: tag the immediate body with the `kind:'project'` discriminant so
        // the client can branch on it without shape-sniffing (the prepare body
        // already carries `kind:'preparation'` via serializeTransition).
        return c.json({
          kind: 'project' as const,
          ...serializeProject(result.projectRow, {
            projectRole: loaded.projectRole,
            effectiveRole: loaded.effectiveRole,
          }),
        });
      }
      // The prepare branch's view is `serializeTransition(...)`, which already
      // carries `kind:'preparation'`.
      return c.json(result.view);
    } catch (err) {
      if (err instanceof ProviderTransitionError) {
        return c.json({ error: err.message }, err.code === 'bad_provider' ? 400 : 404);
      }
      throw err;
    }
  },
);

// GET /:projectId/sandbox-provider/transition — poll the durable provider-migration
// transition for this project. The PATCH prepare branch (Daytona→Platinum) returns
// a `kind:'preparation'` body but does NOT flip the active provider; the client
// polls this endpoint until the transition reaches a terminal status. Project-scoped
// (loadProjectForUser rejects cross-project/non-member with a 404, same scoping as
// the PATCH). The body is a PUBLIC projection (see readPublicProjectTransitionState):
// status / provider / generation / timestamps / user-safe error class only — never
// the lease epoch, lease holder, raw provider error strings, image names, or template
// ids.
projectsApp.openapi(
  createRoute({
    method: 'get',
    path: '/{projectId}/sandbox-provider/transition',
    tags: ['projects'],
    summary: 'Poll the per-project sandbox-provider migration transition',
    ...auth,
    request: {
      params: z.object({ projectId: z.string() }),
    },
    responses: {
      200: json(SandboxProviderTransitionStateSchema, 'Public provider-transition state'),
      ...errors(401, 403, 404),
    },
  }),
  async (c: any) => {
    const projectId = c.req.param('projectId');
    const loaded = await loadProjectForUser(c, projectId, 'read');
    if (!loaded) return c.json({ error: 'Not found' }, 404);
    return c.json(await readPublicProjectTransitionState(projectId));
  },
);
