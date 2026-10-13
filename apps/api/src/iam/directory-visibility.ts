// Which members and groups of an account a caller may see.
//
// `member.read` shows every member and `group.read` every group; owners and
// admins hold both. The built-in `member` role holds neither
// (20261013172952181_member_directory_visibility), so a plain member sees only
// the people and groups they share access with:
//   - themselves, and the account's owners and admins;
//   - every user and group with a role or a grant on a project they can read;
//   - the groups they are in, and every member of a group they can see.
// An owner restores the full directory with a custom account role holding
// `member.read` and `group.read`.
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from './actions';
import type { Actor } from './actor';
import { authorize, listAccessible } from './authorize';
import { groupMemberRows, groupsForMemberRows } from './group-read';
import { accountRoleMap, isAccountManagerRole, projectPrincipals } from './read-models';

export interface VisibleDirectory {
  /** The member user ids the caller may see; null = every member. */
  userIds: Set<string> | null;
  /** The group ids the caller may see; null = every group. */
  groupIds: Set<string> | null;
  /** The project ids the caller may read; null = every project. */
  projectIds: Set<string> | null;
}

/**
 * Never throws: each route keeps its own floor. A token bound to one project
 * holds no account-scope leaf, so it gets the narrow view, scoped to its project.
 */
export async function visibleDirectory(actor: Actor): Promise<VisibleDirectory> {
  const [members, groups] = await Promise.all([
    authorize(actor, ACCOUNT_ACTIONS.MEMBER_READ),
    authorize(actor, ACCOUNT_ACTIONS.GROUP_READ),
  ]);
  if (members.allowed && groups.allowed) return { userIds: null, groupIds: null, projectIds: null };

  const [projects, ownGroups, roles] = await Promise.all([
    listAccessible(actor, PROJECT_ACTIONS.PROJECT_READ, 'project'),
    groupsForMemberRows(actor.accountId, actor.userId),
    accountRoleMap(actor.accountId),
  ]);
  const projectIds = projects.mode === 'allow_only' ? projects.allowed : null;
  const holders =
    projects.mode === 'none' ? [] : await projectPrincipals(actor.accountId, projectIds ? [...projectIds] : undefined);

  const userIds = new Set([actor.userId]);
  const groupIds = new Set(ownGroups.map((g) => g.groupId));
  for (const [userId, role] of roles) if (isAccountManagerRole(role)) userIds.add(userId);
  for (const h of holders) (h.principalType === 'group' ? groupIds : userIds).add(h.principalId);
  if (groupIds.size) for (const m of await groupMemberRows([...groupIds])) userIds.add(m.userId);

  return {
    userIds: members.allowed ? null : userIds,
    groupIds: groups.allowed ? null : groupIds,
    projectIds: projects.mode === 'none' ? new Set() : projectIds,
  };
}
