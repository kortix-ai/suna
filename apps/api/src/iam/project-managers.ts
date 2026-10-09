// Who manages a project: the account's owners and admins (implicit managers of
// every project) plus every user with a direct project `manager` grant. Group
// manager grants are not included. Both sets come from `role_assignments`, so
// the list matches what the manage gates let through.
import { accountRoleMap, isAccountManagerRole, projectRoleGrants } from './read-models';

/** The managers of `projectId`, sorted by user id so every caller gets the same order. */
export async function projectManagerUserIds(accountId: string, projectId: string): Promise<string[]> {
  const [accountRoles, projectGrants] = await Promise.all([
    accountRoleMap(accountId),
    projectRoleGrants({ accountId, projectId }),
  ]);
  const managers = new Set<string>();
  for (const [userId, role] of accountRoles) if (isAccountManagerRole(role)) managers.add(userId);
  for (const grant of projectGrants) if (grant.projectRole === 'manager') managers.add(grant.userId);
  return [...managers].sort();
}
