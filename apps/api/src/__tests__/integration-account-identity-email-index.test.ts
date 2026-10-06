/**
 * Integration test (real local DB): resolving an invitee by email must read
 * auth.users through an index.
 *
 * POST /v1/accounts/:id/members resolves the invitee with
 * resolveAccountIdentityByEmail. Its old predicate, lower(trim(u.email)), matched
 * no index on auth.users, so every call read the whole table: 288k rows on staging
 * and 410k on prod, about 0.2 s each (2026-10-05). Under the release gate's
 * parallel load those scans queued until the route passed its 55 s deadline
 * (503 request_deadline in AGP-7, AGP-11, AUD-5, TOK-6).
 *
 * The local table is tiny, so the planner would pick a sequential scan for any
 * predicate. With seq scans disabled, an indexable predicate plans a scan of the
 * email index; an unindexable one falls back to a full walk of the primary key.
 */
import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { accountIdentityCandidatesQuery } from '../iam/account-identity';

describe('account identity lookup by email', () => {
  test('reads auth.users through an index, never a full scan', async () => {
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const rows = (await tx.execute(
        sql`EXPLAIN ${accountIdentityCandidatesQuery('00000000-0000-4000-8000-0000000000a1', 'nobody@example.test')}`,
      )) as unknown as Array<Record<string, string>>;
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });

    // The email index must drive the read. A filter over a full scan of the
    // table, or of its primary key, reads every row just the same.
    expect(plan).toMatch(/Index Cond: .*lower\(\(email\)::text\)/);
    expect(plan).not.toMatch(/Seq Scan on users u\b/);
    expect(plan).not.toMatch(/Index Scan using users_pkey on users u\b/);
  });
});
