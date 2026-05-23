// Read-side queries for the permission-usage analytics ("Access
// Analyzer"). The recorder writes to iam_action_usage; these helpers
// answer "what's used / unused / who uses what" so admins can
// right-size roles.

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { iamActionUsage, iamRolePermissions, iamRoles } from '@kortix/db';
import { db } from '../shared/db';

export type UsageRow = {
  principalKind: 'user' | 'token';
  principalId: string;
  action: string;
  callCount: number;
  firstUsedAt: Date;
  lastUsedAt: Date;
};

/**
 * Every usage row in the account, newest activity first. Capped to
 * keep payloads bounded — the UI paginates client-side once we have
 * the top slice.
 */
export async function listUsage(
  accountId: string,
  limit: number = 1000,
): Promise<UsageRow[]> {
  const rows = await db
    .select({
      principalKind: iamActionUsage.principalKind,
      principalId: iamActionUsage.principalId,
      action: iamActionUsage.action,
      callCount: iamActionUsage.callCount,
      firstUsedAt: iamActionUsage.firstUsedAt,
      lastUsedAt: iamActionUsage.lastUsedAt,
    })
    .from(iamActionUsage)
    .where(eq(iamActionUsage.accountId, accountId))
    .orderBy(desc(iamActionUsage.lastUsedAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    principalKind: r.principalKind as 'user' | 'token',
  }));
}

/**
 * For a given role, return which of its actions have ever been used in
 * this account, ranked by call count. Drives the "remove unused
 * permissions" suggestion on the role detail page.
 *
 *   actionsInRole: every action the role grants
 *   usedCounts:    actions actually used (sum across principals)
 *   unusedActions: actions in role but never seen
 */
export async function analyseRoleUsage(args: {
  accountId: string;
  roleId: string;
}): Promise<{
  actionsInRole: string[];
  usedCounts: Array<{ action: string; callCount: number; lastUsedAt: Date }>;
  unusedActions: string[];
}> {
  // What actions does this role grant?
  const actionRows = await db
    .select({ action: iamRolePermissions.action })
    .from(iamRolePermissions)
    .innerJoin(iamRoles, eq(iamRoles.roleId, iamRolePermissions.roleId))
    .where(eq(iamRoles.roleId, args.roleId));
  const actionsInRole = actionRows.map((r) => r.action);
  if (actionsInRole.length === 0) {
    return { actionsInRole: [], usedCounts: [], unusedActions: [] };
  }

  // Aggregate usage rows for this account, restricted to this role's
  // action set. Sum across principals — we don't need per-user splits
  // for the "is this action used at all" question.
  const usedRows = await db
    .select({
      action: iamActionUsage.action,
      callCount: sql<number>`SUM(${iamActionUsage.callCount})::int`,
      lastUsedAt: sql<Date>`MAX(${iamActionUsage.lastUsedAt})`,
    })
    .from(iamActionUsage)
    .where(
      and(
        eq(iamActionUsage.accountId, args.accountId),
        sql`${iamActionUsage.action} = ANY(${actionsInRole})`,
      ),
    )
    .groupBy(iamActionUsage.action)
    .orderBy(asc(iamActionUsage.action));

  const used = new Set(usedRows.map((r) => r.action));
  const unusedActions = actionsInRole.filter((a) => !used.has(a));

  return {
    actionsInRole,
    // postgres.js returns MAX(timestamptz) as a string at runtime even
    // though our `sql<Date>` annotation claims Date. Coerce so callers
    // can safely call .toISOString() / Date methods.
    usedCounts: usedRows.map((r) => ({
      action: r.action,
      callCount: r.callCount,
      lastUsedAt: new Date(r.lastUsedAt as unknown as string | Date),
    })),
    unusedActions,
  };
}

/** Usage rolled up per principal — for the "top users by call count"
 *  block on the analytics overview. */
export async function topPrincipals(
  accountId: string,
  limit: number = 25,
): Promise<
  Array<{
    principalKind: 'user' | 'token';
    principalId: string;
    totalCalls: number;
    distinctActions: number;
    lastUsedAt: Date;
  }>
> {
  const rows = await db
    .select({
      principalKind: iamActionUsage.principalKind,
      principalId: iamActionUsage.principalId,
      totalCalls: sql<number>`SUM(${iamActionUsage.callCount})::int`,
      distinctActions: sql<number>`COUNT(DISTINCT ${iamActionUsage.action})::int`,
      lastUsedAt: sql<Date>`MAX(${iamActionUsage.lastUsedAt})`,
    })
    .from(iamActionUsage)
    .where(eq(iamActionUsage.accountId, accountId))
    .groupBy(iamActionUsage.principalKind, iamActionUsage.principalId)
    .orderBy(desc(sql`SUM(${iamActionUsage.callCount})`))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    principalKind: r.principalKind as 'user' | 'token',
    // Same Date coercion as analyseRoleUsage — MAX() comes back as
    // string from postgres.js.
    lastUsedAt: new Date(r.lastUsedAt as unknown as string | Date),
  }));
}
