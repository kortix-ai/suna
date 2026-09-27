/**
 * Integration test (real local PostgreSQL): the index behind the admin
 * accounts-list ordering.
 *
 * Regression for a prod incident (2026-09-27): `GET /v1/admin/api/accounts`
 * (the admin console's default, unfiltered accounts list —
 * `ORDER BY accounts.created_at DESC LIMIT $page_size`) hit the 25s
 * request-path `statement_timeout` (SQLSTATE 57014). API logs showed
 * `GET /v1/admin/api/accounts` at 25013/25019/25056 ms
 * (2026-09-27T01:21-01:22Z), and the route's catch echoed the raw
 * `Failed query: select … "kortix"."credit_accounts"."balance_precise" …`
 * text to the admin browser.
 *
 * `EXPLAIN` against prod (read-only, same day) showed why: `kortix.accounts`
 * had only its primary key, so the planner could not drive the `ORDER BY
 * created_at` from an index. It Hash-Joined a full `Seq Scan` of `accounts`
 * against a full `Seq Scan` of `credit_accounts` (234.5k rows — 5x
 * `accounts`' 45.5k, mostly rows with no live counterpart; nothing FKs
 * `credit_accounts.account_id` back to `accounts`) and `Sort`ed the entire
 * ~44k-row result BEFORE applying `LIMIT`.
 *
 * `idx_accounts_created_at` (this migration:
 * `20260927022710020_accounts_created_at_index.concurrent.ts`) fixes the
 * access path: the planner can now drive the sort with an `Index Scan
 * Backward` + `LIMIT`, then do one `Nested Loop` lookup per row into
 * `credit_accounts`.
 *
 * A near-empty test table costs a seq scan as the CORRECT choice on its own,
 * so this test forces the planner away from one (`enable_seqscan = off`,
 * same technique as `integration-sandbox-turn-lifecycle.test.ts`'s
 * `session_turns_open_idx` test) and asserts the index is STRUCTURALLY
 * usable for the shipped query's join + order + limit shape, not that the
 * planner picks it unprompted on this table's size.
 */
import { describe, expect, test } from 'bun:test';
import { accounts, creditAccounts } from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { db } from '../shared/db';

type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const planText = (result: unknown) =>
  ((result as Rows).rows ?? (result as Rows))
    .map((row) => String(Object.values(row)[0]))
    .join('\n');

describe('idx_accounts_created_at serves the admin accounts-list default ordering', () => {
  test('the join + ORDER BY created_at DESC + LIMIT plan can use the index', async () => {
    const text = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      // Mirrors GET /v1/admin/api/accounts's default (unfiltered, sortBy=created)
      // query in apps/api/src/admin/index.ts: `accounts LEFT JOIN
      // credit_accounts`, ordered by `accounts.createdAt` descending, limited to
      // one page. Built from the real schema objects and the same join
      // predicate (`eq(creditAccounts.accountId, accounts.accountId)`) the route
      // uses, so a rename of either column or the join key breaks this test
      // instead of silently drifting from what is shipped.
      const plan = await tx.execute(sql`
        EXPLAIN SELECT ${accounts.accountId}, ${creditAccounts.balance}
        FROM ${accounts}
        LEFT JOIN ${creditAccounts} ON ${eq(creditAccounts.accountId, accounts.accountId)}
        ORDER BY ${accounts.createdAt} DESC
        LIMIT 50
      `);
      return planText(plan);
    });
    expect(text).toContain('idx_accounts_created_at');
    // The failure mode this index removes: a Sort node ahead of the Limit,
    // fed by a full scan of both tables. `Index Scan Backward` replaces it.
    expect(text).toContain('Index Scan Backward');
  });
});
