/**
 * The `shared_with` list of every shared account in a project: each
 * `connection` grant with its assignment id (what a revoke takes) and a label
 * a person can read — a member, a group, an agent, or everyone. `GET
 * /:projectId/connections` reads it, and
 * `GET /:projectId/secrets` reads the same list for `secret` grants.
 */
import type { ConnectionShare } from '@kortix/api-contract';
import { sql } from 'drizzle-orm';
import { loadObjectGrants } from '../../iam/authorize';
import { objectGrantRows } from '../../iam/read-models';
import { db } from '../../shared/db';
import { accountGroupNamesAmong } from '../../iam/group-read';
import { lookupEmailsByUserIds } from './access';

export async function loadConnectionSharing(input: {
  projectId: string;
  accountId: string;
  projectName: string;
  /** `secret` lists each project secret value's audience, keyed by `secret_id`. */
  objectType?: 'connection' | 'secret';
}): Promise<Map<string, ConnectionShare[]>> {
  const objectType = input.objectType ?? 'connection';
  const byConnection = new Map<string, ConnectionShare[]>();
  // The memoized map answers the common case — nothing narrowed — without a query.
  if ((await loadObjectGrants(input.projectId, objectType)).size === 0) return byConnection;

  const grants = (
    await objectGrantRows({
      accountId: input.accountId,
      projectId: input.projectId,
      includeServiceAccounts: true,
    })
  ).filter((grant) => grant.resourceType === objectType);
  const memberIds = [
    ...new Set(grants.filter((g) => g.principalType === 'member').map((g) => g.principalId)),
  ];
  const groupIds = [
    ...new Set(grants.filter((g) => g.principalType === 'group').map((g) => g.principalId)),
  ];
  const [emailByUser, groupRows] = await Promise.all([
    memberIds.length ? lookupEmailsByUserIds(memberIds) : new Map<string, string | null>(),
    groupIds.length
      ? accountGroupNamesAmong(input.accountId, groupIds)
      : Promise.resolve([] as Array<{ groupId: string; name: string }>),
  ]);
  const groupNameById = new Map(groupRows.map((g) => [g.groupId, g.name] as const));
  const agentNameById = await agentNames(
    grants.filter((g) => g.principalType === 'service_account').map((g) => g.principalId),
  );

  for (const grant of grants) {
    const label =
      grant.principalType === 'member'
        ? (emailByUser.get(grant.principalId) ?? grant.principalId)
        : grant.principalType === 'group'
          ? (groupNameById.get(grant.principalId) ?? grant.principalId)
          : grant.principalType === 'service_account'
            ? (agentNameById.get(grant.principalId) ?? grant.principalId)
            : input.projectName;
    const list = byConnection.get(grant.resourceId) ?? [];
    list.push({
      grant_id: grant.grantId,
      principal_type: grant.principalType === 'service_account' ? 'agent' : grant.principalType,
      principal_id: grant.principalId,
      label,
      expires_at: grant.expiresAt?.toISOString() ?? null,
    });
    byConnection.set(grant.resourceId, list);
  }
  return byConnection;
}

/** An agent's display name: its `agent_name`, else the service account's name.
 *  Raw SQL: suites stub `@kortix/db` with explicit export lists. */
async function agentNames(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const result = await db.execute<{ id: string; label: string }>(sql`
    select service_account_id::text as id, coalesce(agent_name, name) as label
      from kortix.service_accounts
     where service_account_id::text in (${sql.join([...new Set(ids)].map((id) => sql`${id}`), sql`, `)})`);
  const rows = (result as unknown as { rows?: Array<{ id: string; label: string }> }).rows ?? result;
  return new Map((rows as Array<{ id: string; label: string }>).map((row) => [row.id, row.label]));
}
