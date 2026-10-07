import { accountMemberJoinRows } from '../../iam/membership-read';
import { accountGroupNames, groupMemberRows } from '../../iam/group-read';
import { isAccountManager, roleAllows, type AccountRole, type ProjectRole } from '../access';
import { normalizeProjectRole } from '../../iam/roles';
import { accountRoleMap, customRoleBindings, foldProjectAccess, groupProjectGrants, objectGrantRows, projectRoleGrants } from '../../iam/read-models';
import { resolveUserIdentities } from './access';
import { loadProjectForUser } from './access';
type AwaitedProjectAccessLoad = NonNullable<Awaited<ReturnType<typeof loadProjectForUser>>>;
type AccessRows = Awaited<ReturnType<typeof loadProjectAccessRows>>;
type GroupMemberRow = { groupId: string; userId: string };
type ProjectGroupRow = { groupId: string; groupName: string; role: string };

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

type ResourceGrantEntry = {
  grant_id: string;
  resource_type: 'agent' | 'skill';
  resource_id: string;
  /** `project` = the grant names everyone with access to the project. */
  source: 'direct' | 'group' | 'project';
  group_id: string | null;
  group_name: string | null;
  expires_at: string | null;
};

type GroupSource = { group_id: string; group_name: string; role: ProjectRole };

export async function buildProjectAccessView(loaded: AwaitedProjectAccessLoad) {
  const rows = await loadProjectAccessRows(loaded);
  const { identityRows, accountRoles, grantRows, customPolicyRows, objectGrants, accountGroupRows } = rows;

  // Agents and skills only — secrets aren't a member/group-scoped resource
  // surfaced on the access screen (see resource-grants.ts module doc), and a
  // connection grant is a shared account's audience, listed on the connection.
  const resourceGrantRows = objectGrants.filter(
    (r) => r.resourceType === 'agent' || r.resourceType === 'skill',
  );
  const groupNameById = new Map(accountGroupRows.map((g) => [g.groupId, g.name] as const));
  // Inner-join semantics, kept: a grant whose group was deleted is not a source.
  const projectGroupRows = rows.groupGrantRows
    .filter((g) => groupNameById.has(g.groupId))
    .map((g) => ({
      groupId: g.groupId,
      groupName: groupNameById.get(g.groupId)!,
      role: g.role,
    }));

  const groupMemberRows = await loadGroupMembers(projectGroupRows, customPolicyRows, resourceGrantRows);
  const memberUserIdsByGroup = new Map<string, string[]>();
  for (const m of groupMemberRows) {
    const arr = memberUserIdsByGroup.get(m.groupId) ?? [];
    arr.push(m.userId);
    memberUserIdsByGroup.set(m.groupId, arr);
  }

  const customPolicies = foldCustomRolePolicies(customPolicyRows, groupNameById, memberUserIdsByGroup);
  const resourceGrants = foldResourceGrants(resourceGrantRows, groupNameById, memberUserIdsByGroup);
  const groupAccess = buildGroupAccess(
    projectGroupRows,
    customPolicies.byGroup,
    resourceGrants.byGroup,
    groupNameById,
  );
  const groupSourcesByUser = indexGroupSourcesByUser(projectGroupRows, groupMemberRows);

  const members = await buildMemberRows({
    identityRows,
    accountRoles,
    grantRows,
    groupSourcesByUser,
    customPoliciesByUser: customPolicies.byUser,
    resourceGrantsByUser: resourceGrants.byUser,
    everyoneResourceGrants: resourceGrants.everyone,
  });

  return {
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
  };
}

async function loadProjectAccessRows(loaded: AwaitedProjectAccessLoad) {
  // EVERY grant below comes from `kortix.role_assignments` via iam/read-models.
  // The five queries this used to run (account_members.account_role,
  // project_members, project_group_grants, iam_policies, iam_resource_grants)
  // were five stores the engine no longer reads, so this screen could and did
  // disagree with the gate that ran a moment later. `account_members` survives
  // here for IDENTITY only — who is in the directory, and when they joined.
  const [identityRows, accountRoles, grantRows, groupGrantRows, customPolicyRows, objectGrants, accountGroupRows] =
    await Promise.all([
      accountMemberJoinRows(loaded.row.accountId),
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
      accountGroupNames(loaded.row.accountId),
    ]);
  return { identityRows, accountRoles, grantRows, groupGrantRows, customPolicyRows, objectGrants, accountGroupRows };
}

async function loadGroupMembers(
  projectGroupRows: ProjectGroupRow[],
  customPolicyRows: AccessRows['customPolicyRows'],
  resourceGrantRows: AccessRows['objectGrants'],
): Promise<GroupMemberRow[]> {
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
  return allGroupIds.length
    ? await groupMemberRows(allGroupIds)
    : [];
}

function foldCustomRolePolicies(
  customPolicyRows: AccessRows['customPolicyRows'],
  groupNameById: Map<string, string>,
  memberUserIdsByGroup: Map<string, string[]>,
) {
  // Fold custom-role policies onto individual users (direct member principal,
  // or every current member of a group principal) and, separately, keep the
  // per-group view for `group_access` below.
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
  return { byUser: customPoliciesByUser, byGroup: customPoliciesByGroup };
}

function foldResourceGrants(
  resourceGrantRows: AccessRows['objectGrants'],
  groupNameById: Map<string, string>,
  memberUserIdsByGroup: Map<string, string[]>,
) {
  // Fold resource grants (agent/skill) the same way.
  const resourceGrantsByUser = new Map<string, ResourceGrantEntry[]>();
  // Grants to everyone in the project reach every member row below.
  const everyoneResourceGrants: ResourceGrantEntry[] = [];
  const resourceGrantsByGroup = new Map<string, Omit<ResourceGrantEntry, 'source' | 'group_id' | 'group_name'>[]>();
  for (const row of resourceGrantRows) {
    const base = {
      grant_id: row.grantId,
      resource_type: row.resourceType as 'agent' | 'skill',
      resource_id: row.resourceId,
      expires_at: row.expiresAt?.toISOString() ?? null,
    };
    if (row.principalType === 'project') {
      everyoneResourceGrants.push({ ...base, source: 'project', group_id: null, group_name: null });
    } else if (row.principalType === 'member') {
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
  return { byUser: resourceGrantsByUser, byGroup: resourceGrantsByGroup, everyone: everyoneResourceGrants };
}

function buildGroupAccess(
  projectGroupRows: ProjectGroupRow[],
  customPoliciesByGroup: Map<string, Omit<CustomRolePolicyEntry, 'source' | 'group_id' | 'group_name'>[]>,
  resourceGrantsByGroup: Map<string, Omit<ResourceGrantEntry, 'source' | 'group_id' | 'group_name'>[]>,
  groupNameById: Map<string, string>,
) {
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
  return Array.from(groupAccessById.values());
}

function indexGroupSourcesByUser(projectGroupRows: ProjectGroupRow[], groupMemberRows: GroupMemberRow[]) {
  // Index: userId → list of { group_id, group_name, role } that contribute.
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
  return groupSourcesByUser;
}

async function buildMemberRows(input: {
  identityRows: AccessRows['identityRows'];
  accountRoles: AccessRows['accountRoles'];
  grantRows: AccessRows['grantRows'];
  groupSourcesByUser: Map<string, GroupSource[]>;
  customPoliciesByUser: Map<string, CustomRolePolicyEntry[]>;
  resourceGrantsByUser: Map<string, ResourceGrantEntry[]>;
  everyoneResourceGrants: ResourceGrantEntry[];
}) {
  const {
    identityRows,
    accountRoles,
    grantRows,
    groupSourcesByUser,
    customPoliciesByUser,
    resourceGrantsByUser,
    everyoneResourceGrants,
  } = input;
  const identities = await resolveUserIdentities(identityRows.map((r) => r.userId));
  // Drop shadow members: an account_members row pointing at a user_id that is
  // not a real auth user (e.g. a self-referential row where user_id == the
  // account_id). These have no resolvable email and otherwise render as a bare
  // UUID in the access list.
  const realAccountRows = identityRows.filter((r) => identities.get(r.userId)?.exists !== false);
  const grantsByUser = new Map(grantRows.map((r) => [r.userId, r]));
  const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };

  return realAccountRows
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
         *  direct, via a group they belong to, or to everyone in the project. */
        resource_grants: [
          ...(resourceGrantsByUser.get(member.userId) ?? []),
          ...everyoneResourceGrants,
        ],
      };
    })
    .sort((a, b) => {
      const roleDelta = rank[a.account_role] - rank[b.account_role];
      if (roleDelta !== 0) return roleDelta;
      return (a.email ?? a.user_id).localeCompare(b.email ?? b.user_id);
    });
}
