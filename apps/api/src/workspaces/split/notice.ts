/**
 * The split notice on `GET /v1/workspaces/:id` (design.md §3.2 C9): for 30
 * days after a legacy account's last move, each workspace that came out of it
 * says so.
 *
 *   - `moved`: the workspace is the target of a `done` run. `billing` is what
 *     `applySplitOffBilling` gave it (`free` | `comped`), null while that has
 *     not run yet.
 *   - `keeper`: the workspace kept the legacy account, once no move of it is
 *     still open (planned, held, storage_copied). `billing` is null.
 *
 * `source_name` is the legacy account's name before the split (the backup the
 * split wrote when the keeper took over the account name), `completed_at` the
 * account's last move. Derived from `kortix.workspace_split_runs`; no column.
 */
import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';

export const SPLIT_NOTICE_DAYS = 30;

export interface WorkspaceSplitNotice {
  role: 'keeper' | 'moved';
  source_name: string;
  completed_at: string;
  billing: 'free' | 'comped' | null;
  comped_until: string | null;
}

/** The notice of the workspace whose account is `accountId`, or null. */
export async function workspaceSplitNotice(accountId: string): Promise<WorkspaceSplitNotice | null> {
  const [row] = await db.execute<{
    role: 'keeper' | 'moved';
    source_name: string;
    completed_at: string;
    billing: string | null;
    comped_until: string | null;
  }>(sql`
    WITH mine AS (
      SELECT 'moved'::text AS role, r.from_account_id, r.plan->'billing' AS billing, 1 AS ord
        FROM kortix.workspace_split_runs r
       WHERE r.to_account_id = ${accountId} AND r.phase = 'done'
      UNION ALL
      SELECT 'keeper', r.from_account_id, NULL, 2
        FROM kortix.workspace_split_runs r
       WHERE r.from_account_id = ${accountId} AND r.phase = 'done'
         AND NOT EXISTS (SELECT 1 FROM kortix.workspace_split_runs o
                          WHERE o.from_account_id = r.from_account_id AND o.phase IN ('planned', 'held', 'storage_copied'))
    ), last AS (
      SELECT m.role, m.billing, m.ord, m.from_account_id,
             (SELECT max(d.completed_at) FROM kortix.workspace_split_runs d
               WHERE d.from_account_id = m.from_account_id AND d.phase = 'done') AS completed_at
        FROM mine m
    )
    SELECT l.role, COALESCE(b.old_name, a.name) AS source_name,
           to_char(l.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS completed_at,
           l.billing->>'kind' AS billing, l.billing->>'compedUntil' AS comped_until
      FROM last l
      JOIN kortix.accounts a ON a.account_id = l.from_account_id
      LEFT JOIN kortix.workspace_name_backups b ON b.account_id = l.from_account_id
     WHERE l.completed_at > now() - make_interval(days => ${SPLIT_NOTICE_DAYS})
     ORDER BY l.ord, l.completed_at DESC
     LIMIT 1`);
  if (!row) return null;
  return {
    role: row.role,
    source_name: row.source_name,
    completed_at: row.completed_at,
    billing: row.billing === 'free' || row.billing === 'comped' ? row.billing : null,
    comped_until: row.comped_until ?? null,
  };
}
