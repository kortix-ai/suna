import { db } from '../../shared/db';
import { accountGroupMembers } from '@kortix/db';
import { inArray } from 'drizzle-orm';
import { normalizeProjectRole } from '../../iam/roles';
import { foldProjectAccess, type accountRoleMap, type projectRoleGrants, type groupProjectGrants, type customRoleBindings, type objectGrantRows } from '../../iam/read-models';
import { isAccountManager, type AccountRole, type ProjectRole } from '../access';
import { resolveUserIdentities } from './access';

type Rows = {
  identityRows: { userId: string; joinedAt: Date }[];
  accountRoles: Awaited<ReturnType<typeof accountRoleMap>>;
  grantRows: Awaited<ReturnType<typeof projectRoleGrants>>;
  groupGrantRows: Awaited<ReturnType<typeof groupProjectGrants>>;
  customPolicyRows: Awaited<ReturnType<typeof customRoleBindings>>;
  objectGrants: Awaited<ReturnType<typeof objectGrantRows>>;
  accountGroupRows: { groupId: string; name: string }[];
  groupMemberRows: { groupId: string; userId: string }[];
};
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

function foldGroups(rows: Rows) {
  const { groupGrantRows, objectGrants, accountGroupRows, groupMemberRows } = rows;
  // Agents and skills only — secrets aren't a member/group-scoped resource
  // surfaced on the access screen (see resource-grants.ts module doc), and a
  // connection grant is a shared account's audience, listed on the connection.
  const resourceGrantRows = objectGrants.filter(
    (r) => r.resourceType === 'agent' || r.resourceType === 'skill',
  );
  const groupNameById = new Map(accountGroupRows.map((g) => [g.groupId, g.name] as const));
  // Inner-join semantics, kept: a grant whose group was deleted is not a source.
  const projectGroupRows = groupGrantRows
    .filter((g) => groupNameById.has(g.groupId))
    .map((g) => ({
      groupId: g.groupId,
      groupName: groupNameById.get(g.groupId)!,
      role: g.role,
    }));

  const memberUserIdsByGroup = new Map<string, string[]>();
  for (const m of groupMemberRows) {
    const arr = memberUserIdsByGroup.get(m.groupId) ?? [];
    arr.push(m.userId);
    memberUserIdsByGroup.set(m.groupId, arr);
  }

  return { resourceGrantRows, groupNameById, projectGroupRows, memberUserIdsByGroup };
}

function foldPolicies(rows: Rows, groupNameById: Map<string, string>, memberUserIdsByGroup: Map<string, string[]>) {
  const { customPolicyRows } = rows;
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

  return { customPoliciesByUser, customPoliciesByGroup };
}

function foldResources(resourceGrantRows: Rows['objectGrants'], groupNameById: Map<string, string>, memberUserIdsByGroup: Map<string, string[]>) {
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

  return { resourceGrantsByUser, everyoneResourceGrants, resourceGrantsByGroup };
}

function foldGroupAccess(projectGroupRows: { groupId: string; groupName: string; role: string }[], groupNameById: Map<string, string>, customPoliciesByGroup: Map<string, Omit<CustomRolePolicyEntry, 'source' | 'group_id' | 'group_name'>[]>, resourceGrantsByGroup: Map<string, Omit<ResourceGrantEntry, 'source' | 'group_id' | 'group_name'>[]>) {
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

function foldGroupSources(projectGroupRows: { groupId: string; groupName: string; role: string }[], groupMemberRows: Rows['groupMemberRows']) {
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

  return groupSourcesByUser;
}

async function foldMembers(rows: Rows, groupSourcesByUser: ReturnType<typeof foldGroupSources>, customPoliciesByUser: ReturnType<typeof foldPolicies>['customPoliciesByUser'], resourceGrantsByUser: ReturnType<typeof foldResources>['resourceGrantsByUser'], everyoneResourceGrants: ResourceGrantEntry[]) {
  const { identityRows, accountRoles, grantRows } = rows;
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

export async function projectAccessView(rows: Rows) {
  const { resourceGrantRows, groupNameById, projectGroupRows, memberUserIdsByGroup } = foldGroups(rows);
  const { customPoliciesByUser, customPoliciesByGroup } = foldPolicies(rows, groupNameById, memberUserIdsByGroup);
  const { resourceGrantsByUser, everyoneResourceGrants, resourceGrantsByGroup } = foldResources(resourceGrantRows, groupNameById, memberUserIdsByGroup);
  const groupAccess = foldGroupAccess(projectGroupRows, groupNameById, customPoliciesByGroup, resourceGrantsByGroup);
  const groupSourcesByUser = foldGroupSources(projectGroupRows, rows.groupMemberRows);
  const members = await foldMembers(rows, groupSourcesByUser, customPoliciesByUser, resourceGrantsByUser, everyoneResourceGrants);
  return { members, groupAccess };
}

export async function loadAccessGroupMembers(rows: Pick<Rows, 'groupGrantRows' | 'customPolicyRows' | 'objectGrants' | 'accountGroupRows'>) {
  const { groupGrantRows, customPolicyRows, objectGrants, accountGroupRows } = rows;
  const resourceGrantRows = objectGrants.filter(
    (r) => r.resourceType === 'agent' || r.resourceType === 'skill',
  );
  const groupNameById = new Map(accountGroupRows.map((g) => [g.groupId, g.name] as const));
  const projectGroupRows = groupGrantRows.filter((g) => groupNameById.has(g.groupId));
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
  return groupMemberRows;
}
