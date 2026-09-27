/**
 * The `shared_with` list of every shared account in a project: each
 * `connection` grant with its assignment id (what a revoke takes) and a label
 * a person can read. Only `GET /:projectId/connections` reads it.
 */
import type { ConnectionShare } from '@kortix/api-contract';
import { accountGroups } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';
import { loadObjectGrants } from '../../iam/authorize';
import { objectGrantRows } from '../../iam/read-models';
import { db } from '../../shared/db';
import { lookupEmailsByUserIds } from './access';

export async function loadConnectionSharing(input: {
  projectId: string;
  accountId: string;
  projectName: string;
}): Promise<Map<string, ConnectionShare[]>> {
  const byConnection = new Map<string, ConnectionShare[]>();
  // The memoized map answers the common case — nothing narrowed — without a query.
  if ((await loadObjectGrants(input.projectId, 'connection')).size === 0) return byConnection;

  const grants = (
    await objectGrantRows({ accountId: input.accountId, projectId: input.projectId })
  ).filter((grant) => grant.resourceType === 'connection');
  const memberIds = [
    ...new Set(grants.filter((g) => g.principalType === 'member').map((g) => g.principalId)),
  ];
  const groupIds = [
    ...new Set(grants.filter((g) => g.principalType === 'group').map((g) => g.principalId)),
  ];
  const [emailByUser, groupRows] = await Promise.all([
    memberIds.length ? lookupEmailsByUserIds(memberIds) : new Map<string, string | null>(),
    groupIds.length
      ? db
          .select({ groupId: accountGroups.groupId, name: accountGroups.name })
          .from(accountGroups)
          .where(
            and(eq(accountGroups.accountId, input.accountId), inArray(accountGroups.groupId, groupIds)),
          )
      : Promise.resolve([] as Array<{ groupId: string; name: string }>),
  ]);
  const groupNameById = new Map(groupRows.map((g) => [g.groupId, g.name] as const));

  for (const grant of grants) {
    const label =
      grant.principalType === 'member'
        ? (emailByUser.get(grant.principalId) ?? grant.principalId)
        : grant.principalType === 'group'
          ? (groupNameById.get(grant.principalId) ?? grant.principalId)
          : input.projectName;
    const list = byConnection.get(grant.resourceId) ?? [];
    list.push({
      grant_id: grant.grantId,
      principal_type: grant.principalType,
      principal_id: grant.principalId,
      label,
      expires_at: grant.expiresAt?.toISOString() ?? null,
    });
    byConnection.set(grant.resourceId, list);
  }
  return byConnection;
}
