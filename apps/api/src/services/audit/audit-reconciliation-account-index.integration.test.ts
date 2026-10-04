/**
 * Integration test (real local PostgreSQL): the account_id indexes behind
 * the audit-reconciliation worker's per-table scan.
 *
 * Regression for a chronic prod defect: the audit-reconciliation worker
 * (`audit-reconciliation-worker.ts`, `reconcileAuditEvents` in
 * `audit-reconciliation.ts`) runs a per-account `WITH candidates AS (...
 * UNION ALL ...)` query continuously, on every API replica. Two of its
 * source tables had no index on `account_id`, so `EXPLAIN` against prod
 * showed a full scan filtered on it:
 *
 *  - `kortix.session_lifecycle_commands` (336 MB heap, ~24.6 GB TOAST):
 *    `Seq Scan ... Filter: (account_id = ...)`, cost 45306.
 *  - `kortix.connector_calls` (454 MB): `Parallel Seq Scan ... Filter:
 *    (account_id = ...)`, cost 47028.
 *
 * Under load the query hit its statement timeout, and
 * `audit-reconciliation-worker.ts`'s error path retried the same account
 * every 5s forever (see `audit-reconciliation-worker.test.ts`), burning I/O
 * that starved `audit_events` inserts.
 *
 * `idx_session_lifecycle_commands_account`
 * (`20260928125517406_session_lifecycle_commands_account_index.concurrent.ts`)
 * and `idx_connector_calls_account`
 * (`20260928125521418_connector_calls_account_index.concurrent.ts`) give the
 * planner an access path for exactly the predicate each table's branch of
 * `reconcileAuditEvents` issues: `WHERE account_id = $1`, no other filter and
 * no per-table `ORDER BY` (the combined `candidates` CTE sorts once, after
 * the `UNION ALL`), so a single-column index is the correct shape.
 *
 * A near-empty test table costs a seq scan as the CORRECT choice on its own,
 * so the plan tests force the planner away from one (`enable_seqscan = off`,
 * same technique as `admin/accounts-list-index.integration.test.ts`) and
 * assert the index is STRUCTURALLY usable for the shipped predicate, not
 * that the planner picks it unprompted on this table's size.
 */
import { describe, expect, test } from 'bun:test';
import { connectorCalls, sessionLifecycleCommands } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../../lib/db';

const PROBE_ACCOUNT_ID = '00000000-0000-4000-8000-000000000000';

type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const planText = (result: unknown) =>
  ((result as Rows).rows ?? (result as Rows))
    .map((row) => String(Object.values(row)[0]))
    .join('\n');

describe('account_id indexes serve the audit-reconciliation source scan', () => {
  test('idx_session_lifecycle_commands_account: the exact WHERE account_id = $1 predicate can use it', async () => {
    const text = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      // Mirrors the session_lifecycle_commands branch of reconcileAuditEvents's
      // candidates CTE: `FROM kortix.session_lifecycle_commands l WHERE
      // l.account_id = ${accountId}::uuid`, no other predicate.
      const plan = await tx.execute(sql`
        EXPLAIN SELECT 1 FROM ${sessionLifecycleCommands}
        WHERE ${eq(sessionLifecycleCommands.accountId, PROBE_ACCOUNT_ID)}
      `);
      return planText(plan);
    });
    expect(text).toContain('idx_session_lifecycle_commands_account');
    expect(text).not.toContain('Seq Scan');
  });

  test('idx_connector_calls_account: the exact WHERE account_id = $1 predicate can use it', async () => {
    const text = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      // Mirrors the connector_calls branch: `FROM kortix.connector_calls c
      // WHERE c.account_id = ${accountId}::uuid`, no other predicate.
      const plan = await tx.execute(sql`
        EXPLAIN SELECT 1 FROM ${connectorCalls}
        WHERE ${eq(connectorCalls.accountId, PROBE_ACCOUNT_ID)}
      `);
      return planText(plan);
    });
    expect(text).toContain('idx_connector_calls_account');
    expect(text).not.toContain('Seq Scan');
  });

  test('both indexes exist, are valid, and are single-column on account_id', async () => {
    const result = await db.execute<{
      indexname: string;
      tablename: string;
      indexdef: string;
      indisvalid: boolean;
    }>(sql`
      SELECT i.relname AS "indexname", t.relname AS "tablename",
             pg_get_indexdef(ix.indexrelid) AS "indexdef", ix.indisvalid AS "indisvalid"
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = 'kortix'
         AND i.relname IN ('idx_session_lifecycle_commands_account', 'idx_connector_calls_account')
       ORDER BY i.relname
    `);
    const rows = Array.from(
      result as unknown as Array<{
        indexname: string;
        tablename: string;
        indexdef: string;
        indisvalid: boolean;
      }>,
    );
    expect(rows.map((row) => [row.indexname, row.tablename])).toEqual([
      ['idx_connector_calls_account', 'connector_calls'],
      ['idx_session_lifecycle_commands_account', 'session_lifecycle_commands'],
    ]);
    for (const row of rows) {
      expect(row.indisvalid).toBe(true);
      expect(row.indexdef).toContain('(account_id)');
    }
  });
});
