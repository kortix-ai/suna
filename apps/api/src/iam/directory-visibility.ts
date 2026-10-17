// Which members and groups of an account a caller may see.
//
// `member.read` shows every member and `group.read` every group; owners and
// admins hold both. The built-in `member` role holds neither
// (20261013172952181_member_directory_visibility), so a plain member sees
// nobody but themselves and no group, not even their own. The one exception is
// a project they manage: its access list shows the people and groups with
// access to that project (`visibleProjectRoster`). An owner restores the full
// directory with a custom account role holding `member.read` and `group.read`.
import { ACCOUNT_ACTIONS, PROJECT_ACTIONS } from './actions';
import type { Actor } from './actor';
import { authorize, listAccessible } from './authorize';

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
 * holds no account-scope leaf, so it gets the narrow view.
 */
export async function visibleDirectory(actor: Actor): Promise<VisibleDirectory> {
  const [members, groups] = await Promise.all([
    authorize(actor, ACCOUNT_ACTIONS.MEMBER_READ),
    authorize(actor, ACCOUNT_ACTIONS.GROUP_READ),
  ]);
  if (members.allowed && groups.allowed) return { userIds: null, groupIds: null, projectIds: null };
  const projects = await listAccessible(actor, PROJECT_ACTIONS.PROJECT_READ, 'project');
  return {
    userIds: members.allowed ? null : new Set([actor.userId]),
    groupIds: groups.allowed ? null : new Set(),
    projectIds: projects.mode === 'none' ? new Set() : projects.mode === 'allow_only' ? projects.allowed : null,
  };
}

/**
 * A project's access list as the caller may see it. Without `member.read` a
 * caller sees themselves; a caller who manages the project also sees everyone
 * with access to it, so they can manage them, and still nobody without access.
 * Without `group.read` the groups are hidden unless the caller manages the
 * project; `group_access` lists only groups with access to it.
 */
export function visibleProjectRoster<
  View extends {
    can_manage: boolean;
    members: Array<{ user_id: string; effective_project_role: string | null }>;
    group_access: Array<{ group_id: string }>;
  },
>(view: View, visible: Pick<VisibleDirectory, 'userIds' | 'groupIds'>): View {
  const { userIds, groupIds } = visible;
  return {
    ...view,
    members: view.members.filter(
      (m) => !userIds || userIds.has(m.user_id) || (view.can_manage && m.effective_project_role !== null),
    ),
    group_access: view.group_access.filter((g) => !groupIds || groupIds.has(g.group_id) || view.can_manage),
  };
}
