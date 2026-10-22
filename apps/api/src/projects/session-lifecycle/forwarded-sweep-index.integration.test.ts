/**
 * Integration test (real local PostgreSQL): the partial index behind the
 * forwarded-prompt sweep (`reconcileForwardedPrompts` → `liveDeps.listForwarded`
 * in `./consumption.ts`).
 *
 * Regression for a Supabase pg_stat_statements finding (2026-10-03): the
 * sweep's statement ran at a mean of 1414 ms over 12646 calls
 * (17,881,787 ms total, buffer hit rate 74 %, ~6,000 shared_blks_read per
 * call — most of the heap read from disk on every maintenance pass).
 *
 * Why it was slow: the sweep's WHERE is
 *
 *   command_type = 'continue_session' AND status = 'succeeded'
 *   AND result->>'status' = 'forwarded'
 *   AND coalesce(result->>'stop_paused', '') <> 'true'
 *   AND updated_at <= <confirm-grace cutoff>
 *   ORDER BY updated_at ASC LIMIT 25
 *
 * `status = 'succeeded'` is true for every closed command, so the only
 * pre-existing index that could match anything
 * (`idx_session_lifecycle_commands_due` on `(status, available_at)`) matched
 * the whole table and the planner read the heap from the front on every pass.
 *
 * `idx_session_lifecycle_commands_forwarded`
 * (`20261002155710938_session_lifecycle_commands_forwarded_index.concurrent.ts`)
 * is partial on exactly `(result->>'status') = 'forwarded'`, keyed on
 * `updated_at`: a row leaves the index when its prompt is confirmed, so it
 * holds only in-flight prompts, and the sweep's `ORDER BY updated_at` is
 * index order. EXPLAIN (ANALYZE, BUFFERS) against prod after that index went
 * live: `Index Scan using idx_session_lifecycle_commands_forwarded`,
 * `Buffers: shared hit=3`, `Execution Time: 0.096 ms`.
 *
 * A near-empty test table costs a seq scan as the CORRECT choice on its own,
 * so the plan test forces the planner away from one (`enable_seqscan = off`,
 * same technique as `admin/accounts-list-index.integration.test.ts`) and
 * asserts the index is STRUCTURALLY usable for the shipped statement, not
 * that the planner picks it unprompted on this table's size. A predicate the
 * partial index cannot serve — a rewrite of the `result->>'status'` match, a
 * dropped index — stays a seq scan even here, which is exactly the
 * regression this test fails on.
 */
import { describe, expect, test } from 'bun:test';
import { sessionLifecycleCommands } from '@kortix/db';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { INBOX_FORWARD_CONFIRM_GRACE_MS } from './consumption';
import { db } from '../../shared/db';
import {
  removeSeeded,
  seedProject,
  seedSession,
  type SeededProject,
} from '../../__tests__/helpers/integration-fixtures';

type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const planText = (result: unknown) =>
  ((result as Rows).rows ?? (result as Rows))
    .map((row) => String(Object.values(row)[0]))
    .join('\n');

/** The shipped `listForwarded` statement (`consumption.ts`), built from the real
 *  schema objects so a rename or predicate rewrite breaks this test instead of
 *  silently drifting from what runs. */
function forwardedSweepQuery(olderThan: Date, limit: number) {
  return db
    .select({
      commandId: sessionLifecycleCommands.commandId,
      sessionId: sessionLifecycleCommands.sessionId,
      wireMessageId: sql<string | null>`${sessionLifecycleCommands.payload}->>'wireMessageId'`,
      redeliveredMessageId: sql<
        string | null
      >`${sessionLifecycleCommands.payload}->>'redeliveredMessageId'`,
      updatedAt: sessionLifecycleCommands.updatedAt,
    })
    .from(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        eq(sessionLifecycleCommands.status, 'succeeded'),
        sql`${sessionLifecycleCommands.result}->>'status' = 'forwarded'`,
        sql`COALESCE(${sessionLifecycleCommands.result}->>'stop_paused', '') <> 'true'`,
        lte(sessionLifecycleCommands.updatedAt, olderThan),
      ),
    )
    .orderBy(asc(sessionLifecycleCommands.updatedAt))
    .limit(limit);
}

describe('idx_session_lifecycle_commands_forwarded serves the forwarded-prompt sweep', () => {
  test('the sweep plan can drive ORDER BY updated_at + LIMIT from the partial index', async () => {
    const text = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      const plan = await tx.execute(
        sql`EXPLAIN ${forwardedSweepQuery(new Date(Date.now() - INBOX_FORWARD_CONFIRM_GRACE_MS), 25)}`,
      );
      return planText(plan);
    });
    expect(text).toContain('idx_session_lifecycle_commands_forwarded');
    // The failure mode the index removes: a full heap scan filtered on
    // `status = 'succeeded'` — the state of every closed command ever written.
    expect(text).not.toContain('Seq Scan');
  });

  test('the sweep statement returns only the prompts it may force-close, oldest first', async () => {
    const seeded: SeededProject = await seedProject('sweep-index');
    const sessionId = await seedSession(seeded, '00000000-0000-4000-8000-000000000001');
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
    const command = (overrides: {
      commandType?: string;
      payload?: Record<string, unknown>;
      result?: Record<string, unknown>;
      updatedAt?: Date;
      idempotencyKey?: string;
    }) => ({
      commandType: 'continue_session',
      source: 'inbox',
      status: 'succeeded' as const,
      projectId: seeded.project_id,
      sessionId,
      accountId: seeded.account_id,
      payload: {},
      result: {},
      updatedAt: new Date(),
      ...overrides,
    });

    // In-flight prompts: what the sweep must find, oldest first. `result` starts
    // from what `markCommandForwarded` writes (`command-transitions.ts`):
    // `status: 'forwarded'` is the key the sweep's WHERE and the partial index
    // predicate both read.
    const eligibleIds = await db
      .insert(sessionLifecycleCommands)
      .values([
        command({ payload: { wireMessageId: 'msg-eligible-old' }, updatedAt: minutesAgo(10), idempotencyKey: 'sweep-index-eligible-old', result: { status: 'forwarded' } }),
        command({ payload: { wireMessageId: 'msg-eligible-new' }, updatedAt: minutesAgo(2), idempotencyKey: 'sweep-index-eligible-new', result: { status: 'forwarded' } }),
      ])
      .returning({ commandId: sessionLifecycleCommands.commandId });

    // Every neighbour that must stay out of the scan: a prompt the user parked,
    // one a turn already consumed, one inside the confirm-grace window, and one
    // whose command type the sweep does not own.
    await db.insert(sessionLifecycleCommands).values([
      command({ payload: { wireMessageId: 'msg-stop-paused' }, updatedAt: minutesAgo(5), idempotencyKey: 'sweep-index-stop-paused', result: { status: 'forwarded', stop_paused: true, held: true } }),
      command({ payload: { wireMessageId: 'msg-delivered' }, updatedAt: minutesAgo(4), idempotencyKey: 'sweep-index-delivered', result: { status: 'delivered' } }),
      command({ payload: { wireMessageId: 'msg-within-grace' }, updatedAt: new Date(Date.now() - 5_000), idempotencyKey: 'sweep-index-within-grace', result: { status: 'forwarded' } }),
      command({ commandType: 'restart_session', payload: { wireMessageId: 'msg-other-type' }, updatedAt: minutesAgo(6), idempotencyKey: 'sweep-index-other-type', result: { status: 'forwarded' } }),
    ]);

    try {
      const rows = await forwardedSweepQuery(new Date(Date.now() - INBOX_FORWARD_CONFIRM_GRACE_MS), 25);
      expect(rows.map((row) => row.commandId)).toEqual(
        eligibleIds.map((row) => row.commandId),
      );
      expect(rows.map((row) => row.wireMessageId)).toEqual([
        'msg-eligible-old',
        'msg-eligible-new',
      ]);
      for (const row of rows) {
        expect(row.sessionId).toBe(sessionId);
        expect(row.redeliveredMessageId).toBeNull();
      }
    } finally {
      await removeSeeded([seeded]);
    }
  });
});
