import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';
import type { AccountGroup, GroupMember } from './iam-types';

// ─── Groups ────────────────────────────────────────────────────────────────

export async function listGroups(accountId: string) {
  return unwrap(await iamGet<{ groups: AccountGroup[] }>(`/accounts/${accountId}/iam/groups`))
    .groups;
}

export async function getGroup(accountId: string, groupId: string) {
  return unwrap(await iamGet<AccountGroup>(`/accounts/${accountId}/iam/groups/${groupId}`));
}

export async function createGroup(
  accountId: string,
  input: { name: string; description?: string },
) {
  return unwrap(
    await backendApi.post<AccountGroup>(`/accounts/${accountId}/iam/groups`, input, {
      showErrors: false,
    }),
  );
}

export async function updateGroup(
  accountId: string,
  groupId: string,
  patch: { name?: string; description?: string | null },
) {
  return unwrap(
    await backendApi.patch<AccountGroup>(`/accounts/${accountId}/iam/groups/${groupId}`, patch),
  );
}

export async function deleteGroup(accountId: string, groupId: string) {
  return unwrap(
    await backendApi.delete<{ deleted: boolean }>(`/accounts/${accountId}/iam/groups/${groupId}`),
  );
}

export async function listGroupMembers(accountId: string, groupId: string) {
  return unwrap(
    await iamGet<{ members: GroupMember[] }>(
      `/accounts/${accountId}/iam/groups/${groupId}/members`,
    ),
  ).members;
}

export async function addGroupMembers(accountId: string, groupId: string, userIds: string[]) {
  return unwrap(
    await backendApi.post<{ added: number }>(
      `/accounts/${accountId}/iam/groups/${groupId}/members`,
      { userIds },
    ),
  );
}

// V2-only: which projects is this group attached to + at what role?
// Backed by GET /accounts/:id/iam/groups/:gid/project-grants. Each row
// can be detached via the per-project DELETE /projects/:pid/group-grants/:gid
// endpoint (already in projects-client as detachGroupFromProject).
export interface GroupProjectGrant {
  project_id: string;
  project_name: string;
  role: 'manager' | 'member';
  granted_by: string | null;
  created_at: string;
  /** Auto-revoke timestamp (ISO). null = permanent. Surfaced from the
   *  backend's project_group_grants.expires_at. */
  expires_at?: string | null;
}

export async function listGroupProjectGrants(accountId: string, groupId: string) {
  return unwrap(
    await iamGet<{ grants: GroupProjectGrant[] }>(
      `/accounts/${accountId}/iam/groups/${groupId}/project-grants`,
    ),
  ).grants;
}

export async function removeGroupMember(accountId: string, groupId: string, userId: string) {
  return unwrap(
    await backendApi.delete<{ removed: boolean }>(
      `/accounts/${accountId}/iam/groups/${groupId}/members/${userId}`,
    ),
  );
}

export interface MemberGroupSummary {
  group_id: string;
  name: string;
  added_at: string;
}

/** Groups the given user belongs to within the account. Reverse of
 *  listGroupMembers — backs the "via groups" panel on member detail. */
export async function listMemberGroups(accountId: string, userId: string) {
  return unwrap(
    await iamGet<{ groups: MemberGroupSummary[] }>(
      `/accounts/${accountId}/iam/members/${userId}/groups`,
    ),
  ).groups;
}

// V2-only: which projects can this member reach, at what role, and how?
// `sources` tells the UI why they have access (one or more of):
//   implicit — they're an account owner/admin (manager on every project)
//   direct   — explicit project_members row
//   group    — inherited from a project_group_grants attachment
export interface MemberProjectAccess {
  project_id: string;
  project_name: string;
  role: 'manager' | 'member';
  sources: Array<'implicit' | 'direct' | 'group'>;
  /** Custom (non-built-in) roles this member holds on this project via a
   *  direct or group-inherited policy, layered on top of `role`. Loosely
   *  typed and optional to match this endpoint family's existing convention
   *  (e.g. GroupProjectGrant.expires_at) rather than a new strict export. */
  custom_role_policies?: Array<{
    policy_id: string;
    role_id: string;
    role_key: string;
    role_name: string;
    source: 'direct' | 'group';
    group_id: string | null;
    group_name: string | null;
    expires_at: string | null;
  }>;
}

export async function listMemberProjectAccess(accountId: string, userId: string) {
  const data = unwrap(
    await iamGet<{
      projects: MemberProjectAccess[];
      /** scope_type='account' custom-role policies that apply to every
       *  project — the UI shows these once instead of duplicating them per
       *  row. Same shape as MemberProjectAccess['custom_role_policies']. */
      account_wide_policies?: MemberProjectAccess['custom_role_policies'];
    }>(`/accounts/${accountId}/iam/members/${userId}/project-access`),
  );
  return {
    projects: data.projects,
    account_wide_policies: data.account_wide_policies ?? [],
  };
}
