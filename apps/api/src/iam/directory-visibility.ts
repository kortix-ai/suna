// Which members and groups of an account a caller may see.
//
// `member.read` shows every member and `group.read` every group; owners and
// admins hold both. The built-in `member` role holds neither
// (20261013172952181_member_directory_visibility), so a plain member sees only
// the people and groups they share access with:
//   - themselves;
//   - the groups they are in, and every member of those groups;
//   - every user and group with a role or a grant on a project they manage
//     (`project.members.manage`), and the members of those groups.
// Reading a project is not enough. When every group of an account holds a role
// on one shared project, "anyone on a project you can read" is the whole org.
// An owner restores the full directory with a custom account role holding
// `member.read` and `group.read`.
import { roleAssignments } from '@kortix/db';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from './actions';
import type { Actor } from './actor';
import { authorize, listAccessible } from './authorize';
import { groupMemberRows, groupsForMemberRows } from './group-read';

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

  const [projects, managed, ownGroups] = await Promise.all([
    listAccessible(actor, PROJECT_ACTIONS.PROJECT_READ, 'project'),
    listAccessible(actor, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, 'project'),
    groupsForMemberRows(actor.accountId, actor.userId),
  ]);
  const projectIds = projects.mode === 'allow_only' ? projects.allowed : null;
  const managedIds = managed.mode === 'allow_only' ? managed.allowed : null;
  const holders =
    managed.mode === 'none' ? [] : await projectPrincipals(actor.accountId, managedIds ? [...managedIds] : undefined);

  const userIds = new Set([actor.userId]);
  const groupIds = new Set(ownGroups.map((g) => g.groupId));
  for (const h of holders) (h.principalType === 'group' ? groupIds : userIds).add(h.principalId);
  if (groupIds.size) for (const m of await groupMemberRows([...groupIds])) userIds.add(m.userId);

  return {
    userIds: members.allowed ? null : userIds,
    groupIds: groups.allowed ? null : groupIds,
    projectIds: projects.mode === 'none' ? new Set() : projectIds,
  };
}

/**
 * Every user and group holding a live assignment on one of the projects: a
 * project role, a custom role, or an object grant. Omit `projectIds` for every
 * project of the account. Kept here, not in `read-models`: many unit tests mock
 * that module with a fixed export list.
 */
function projectPrincipals(accountId: string, projectIds?: string[]) {
  if (projectIds && projectIds.length === 0) return Promise.resolve([]);
  const clauses = [
    eq(roleAssignments.accountId, accountId),
    eq(roleAssignments.scopeType, 'project'),
    inArray(roleAssignments.principalType, ['user', 'group']),
    or(isNull(roleAssignments.expiresAt), gt(roleAssignments.expiresAt, sql`now()`)),
  ];
  if (projectIds) clauses.push(inArray(roleAssignments.scopeId, projectIds));
  return db
    .selectDistinct({ principalType: roleAssignments.principalType, principalId: roleAssignments.principalId })
    .from(roleAssignments)
    .where(and(...clauses));
}
