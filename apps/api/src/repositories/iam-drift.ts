// IAM drift detection: surface stale / cleanup-candidate IAM objects
// so admins can prune. Read-only queries — nothing is mutated.
//
// v1 surfaces four categories:
//   - unused policies (no recorded usage in the lookback window)
//   - empty groups (no members)
//   - orphan groups (no policies attached)
//   - expired policies still present (cleanup candidates)
//
// The lookback window is conservative — short enough to catch genuine
// drift, long enough that holiday gaps don't trigger false positives.

import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import {
  accountGroupMembers,
  accountGroups,
  iamActionUsage,
  iamPolicies,
  iamRoles,
} from '@kortix/db';
import { db } from '../shared/db';

const DEFAULT_UNUSED_LOOKBACK_DAYS = 60;

export interface DriftReport {
  unused_policies: Array<{
    policy_id: string;
    role_key: string;
    role_name: string;
    principal_type: 'member' | 'group' | 'token';
    principal_id: string;
    scope_type: string;
    scope_id: string | null;
    created_at: string;
    last_used_at: string | null;
  }>;
  empty_groups: Array<{ group_id: string; name: string; created_at: string }>;
  orphan_groups: Array<{ group_id: string; name: string }>;
  expired_policies: Array<{
    policy_id: string;
    principal_type: 'member' | 'group' | 'token';
    principal_id: string;
    role_id: string;
    expires_at: string;
  }>;
  lookback_days: number;
}

export async function computeDriftReport(args: {
  accountId: string;
  lookbackDays?: number;
}): Promise<DriftReport> {
  const lookback = args.lookbackDays ?? DEFAULT_UNUSED_LOOKBACK_DAYS;
  // Compute the cutoff in SQL via `now() - interval` to avoid JS-Date
  // serialisation issues — drizzle + postgres.js will send a raw
  // Date as `toString()` output ("Tue Mar 24 …"), which Postgres
  // can't compare to a timestamptz. Bind the day count as an integer
  // and cast to interval server-side.

  // 1. Unused policies. Definition: a policy whose role grants actions
  // none of which have been observed for the policy's principal within
  // the lookback window. We approximate by checking max(last_used_at)
  // across iam_action_usage rows that match the principal at all —
  // false-positives are possible when usage was recorded against a
  // different principal_kind, but the surface is "candidates to
  // review" so over-reporting is preferable to silent drift.
  const unusedRows = await db.execute<{
    policy_id: string;
    role_key: string;
    role_name: string;
    principal_type: string;
    principal_id: string;
    scope_type: string;
    scope_id: string | null;
    created_at: Date | string;
    last_used_at: Date | string | null;
  }>(sql`
    SELECT
      p.policy_id::text,
      r.key      AS role_key,
      r.name     AS role_name,
      p.principal_type::text,
      p.principal_id::text,
      p.scope_type::text,
      p.scope_id::text,
      p.created_at,
      (
        SELECT MAX(u.last_used_at)
        FROM kortix.iam_action_usage u
        WHERE u.account_id = p.account_id
          AND u.principal_id = p.principal_id
      ) AS last_used_at
    FROM kortix.iam_policies p
    INNER JOIN kortix.iam_roles r ON r.role_id = p.role_id
    WHERE p.account_id = ${args.accountId}::uuid
      AND p.created_at < now() - (${lookback}::int * interval '1 day')
      AND (
        NOT EXISTS (
          SELECT 1
          FROM kortix.iam_action_usage u
          WHERE u.account_id = p.account_id
            AND u.principal_id = p.principal_id
            AND u.last_used_at >= now() - (${lookback}::int * interval '1 day')
        )
      )
    ORDER BY p.created_at ASC
    LIMIT 200
  `);
  const unusedData =
    ((unusedRows as unknown) as { rows: typeof unusedRows }).rows ?? unusedRows;

  // 2. Empty groups (no account_group_members rows).
  const emptyRows = await db
    .select({
      groupId: accountGroups.groupId,
      name: accountGroups.name,
      createdAt: accountGroups.createdAt,
    })
    .from(accountGroups)
    .where(
      and(
        eq(accountGroups.accountId, args.accountId),
        sql`NOT EXISTS (
          SELECT 1 FROM kortix.account_group_members gm
          WHERE gm.group_id = ${accountGroups.groupId}
        )`,
      ),
    )
    .limit(200);

  // 3. Orphan groups (no policies attached). Groups in this state are
  // pure organisational pots — fine in moderation, but useful to
  // surface so admins can clean up after pilots.
  const orphanRows = await db
    .select({ groupId: accountGroups.groupId, name: accountGroups.name })
    .from(accountGroups)
    .where(
      and(
        eq(accountGroups.accountId, args.accountId),
        sql`NOT EXISTS (
          SELECT 1 FROM kortix.iam_policies p
          WHERE p.account_id = ${args.accountId}::uuid
            AND p.principal_type = 'group'
            AND p.principal_id = ${accountGroups.groupId}
        )`,
      ),
    )
    .limit(200);

  // 4. Expired policies still present. The engine filters these out at
  // request time, but they clutter lists — propose deletion.
  const expiredRows = await db
    .select({
      policyId: iamPolicies.policyId,
      principalType: iamPolicies.principalType,
      principalId: iamPolicies.principalId,
      roleId: iamPolicies.roleId,
      expiresAt: iamPolicies.expiresAt,
    })
    .from(iamPolicies)
    .where(
      and(
        eq(iamPolicies.accountId, args.accountId),
        lt(iamPolicies.expiresAt, sql`now()`),
      ),
    )
    .limit(200);

  // Touch unused imports so the compiler agrees we use them all.
  void iamRoles;
  void isNull;
  void accountGroupMembers;
  void iamActionUsage;

  return {
    unused_policies: (unusedData as Array<{
      policy_id: string;
      role_key: string;
      role_name: string;
      principal_type: string;
      principal_id: string;
      scope_type: string;
      scope_id: string | null;
      created_at: Date | string;
      last_used_at: Date | string | null;
    }>).map((r) => ({
      policy_id: r.policy_id,
      role_key: r.role_key,
      role_name: r.role_name,
      principal_type: r.principal_type as 'member' | 'group' | 'token',
      principal_id: r.principal_id,
      scope_type: r.scope_type,
      scope_id: r.scope_id,
      // postgres.js may return timestamps as strings or Dates depending
      // on driver config. Normalise via Date() so the response shape
      // is always ISO-8601.
      created_at: new Date(r.created_at).toISOString(),
      last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    })),
    empty_groups: emptyRows.map((r) => ({
      group_id: r.groupId,
      name: r.name,
      created_at: r.createdAt.toISOString(),
    })),
    orphan_groups: orphanRows.map((r) => ({ group_id: r.groupId, name: r.name })),
    expired_policies: expiredRows.map((r) => ({
      policy_id: r.policyId,
      principal_type: r.principalType as 'member' | 'group' | 'token',
      principal_id: r.principalId,
      role_id: r.roleId,
      expires_at: r.expiresAt ? r.expiresAt.toISOString() : '',
    })),
    lookback_days: lookback,
  };
}
