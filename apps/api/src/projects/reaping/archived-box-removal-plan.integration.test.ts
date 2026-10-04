/**
 * Integration test (real local PostgreSQL): the index behind the provider
 * box reaper's pending-removal scan.
 *
 * Regression for the KRTX-1309 prod finding: `removeArchivedProviderBoxes`
 * (the lane that retries provider box removal for deleted sessions) ran at a
 * mean of 1609 ms over ~2300 prod calls, returning zero rows. Its predicate
 * lives in `metadata` (`? 'providerRemovalPendingAt'`), which
 * `idx_session_sandboxes_status` knows nothing about, so every lane run
 * seq-scanned every archived row and decoded its jsonb to find nothing.
 *
 * `idx_session_sandboxes_provider_removal_pending`
 * (`20261004030607968_session_sandboxes_provider_removal_pending_index.concurrent.ts`)
 * carries the exact predicate AND the query's sort expression, so the lane
 * probes a (usually empty) partial index instead of the whole archived set.
 * `status` is the index's leading KEY, not a partial predicate: the app binds
 * it as a parameter, and a generic plan cannot prove `status = $1` implies
 * `status = 'archived'` — the second plan test pins that the index still
 * answers the prepared statement under `plan_cache_mode = force_generic_plan`.
 *
 * The plan test runs the shipped statement (`removeArchivedProviderBoxesQuery`)
 * against a 2000-row archived set the planner sees naturally, so it asserts
 * what prod gets — the partial index instead of a Seq Scan — without planner
 * knobs. The row test pins the query's semantics against the index: only
 * archived rows with an external box and the pending stamp, ordered by
 * `metadata->>'providerRemovalRetryAfterAt'` with never-attempted rows (no
 * stamp) first, honoring the 50-row batch.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import {
  localTestDatabaseUrl,
  removeSeeded,
  seedProject,
  type SeededProject,
} from '../../__tests__/helpers/integration-fixtures';
import { removeArchivedProviderBoxesQuery } from './archived-box-removal';

const SESSION_PREFIX = 'krtx1309-reaper-plan-';
const ARCHIVED_ROWS = 2000;
const FILLER_PENDING_ROWS = 55;

type Rows = { rows?: Array<Record<string, unknown>> } & Array<Record<string, unknown>>;
const planText = (result: unknown) =>
  ((result as Rows).rows ?? (result as Rows))
    .map((row) => String(Object.values(row)[0]))
    .join('\n');

/** The batch limit removeArchivedProviderBoxes reads. */
const BATCH = 50;

let seeded: SeededProject;
const iso = (ms: number) => new Date(ms).toISOString();
// Fixed epoch, one minute apart, all `toISOString`-shaped (the shape the
// writers store), so the lexicographic text order is the chronological one.
const minute = (i: number) => iso(Date.UTC(2026, 0, 1, 0, i));

/**
 * Remove every row this suite seeded. `guard_session_sandbox_identity` refuses
 * to delete the sandbox row of a session that is not tombstoned, so tombstone
 * each seeded session first (the guard's own sanctioned path, the same cleanup
 * integration-session-status-transitions.test.ts uses), then delete the rows
 * and the tombstones. Runs before the seed too, so a re-run against a
 * persistent database starts clean.
 */
async function cleanupRows() {
  await db.execute(sql`
    insert into ${projectSessions} (session_id, account_id, project_id, branch_name, metadata)
    select session_id, account_id, project_id, 'cleanup/' || session_id,
      '{"deletedAt":"cleanup"}'::jsonb
      from ${sessionSandboxes} where session_id like ${`${SESSION_PREFIX}%`}
    on conflict (session_id) do update
      set metadata = coalesce(project_sessions.metadata, '{}'::jsonb) || '{"deletedAt":"cleanup"}'::jsonb
  `);
  await db.execute(sql`delete from ${sessionSandboxes} where session_id like ${`${SESSION_PREFIX}%`}`);
  await db.execute(sql`delete from ${projectSessions} where session_id like ${`${SESSION_PREFIX}%`}`);
}

beforeAll(async () => {
  seeded = await seedProject('krtx1309-reaper-plan');
  await cleanupRows();
  // The bulk of the archived set: past removals, no pending stamp. This is the
  // rows the seq scan used to decode on every lane run.
  await db.execute(sql`
    insert into ${sessionSandboxes}
      (sandbox_id, session_id, account_id, project_id, provider, external_id, base_url, status, config, metadata, active_since, deadline_at)
    select gen_random_uuid(), ${SESSION_PREFIX} || g,
      ${seeded.account_id}::uuid, ${seeded.project_id}::uuid, 'daytona',
      'ext-' || g, 'https://box.example.test', 'archived', '{}'::jsonb,
      jsonb_build_object('providerRemovedAt', now()::text, 'turnCount', g % 50, 'notes', repeat('x', 64)),
      now(), now()
    from generate_series(1, ${ARCHIVED_ROWS}) g
  `);
  // The lane's real work: archived rows stamped pending. One never attempted
  // (no retry stamp — sorts first under NULLS FIRST), one with a past stamp,
  // one with a future stamp, and filler up to past the batch limit.
  await db.insert(sessionSandboxes).values([
    {
      sandboxId: crypto.randomUUID(),
      sessionId: `${SESSION_PREFIX}pending-null-retry`,
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      externalId: 'ext-pending-null-retry',
      status: 'archived',
      metadata: { providerRemovalPendingAt: minute(0) },
    },
    {
      sandboxId: crypto.randomUUID(),
      sessionId: `${SESSION_PREFIX}pending-past`,
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      externalId: 'ext-pending-past',
      status: 'archived',
      metadata: { providerRemovalPendingAt: minute(0), providerRemovalRetryAfterAt: minute(1) },
    },
    {
      sandboxId: crypto.randomUUID(),
      sessionId: `${SESSION_PREFIX}pending-future`,
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      externalId: 'ext-pending-future',
      status: 'archived',
      metadata: { providerRemovalPendingAt: minute(0), providerRemovalRetryAfterAt: minute(2) },
    },
    ...Array.from({ length: FILLER_PENDING_ROWS }, (_, i) => ({
      sandboxId: crypto.randomUUID(),
      sessionId: `${SESSION_PREFIX}pending-filler-${i}`,
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      externalId: `ext-pending-filler-${i}`,
      status: 'archived' as const,
      metadata: { providerRemovalPendingAt: minute(0), providerRemovalRetryAfterAt: minute(10 + i) },
    })),
  ]);
  // Two rows the predicate must exclude: a stamped row with no external box
  // (unremovable — it must not occupy the batch) and a stamped row that is not
  // archived (deleteSession stamps archived rows only; a drifted writer must
  // not leak into this lane).
  await db.insert(sessionSandboxes).values([
    {
      sandboxId: crypto.randomUUID(),
      sessionId: `${SESSION_PREFIX}pending-no-external`,
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      externalId: null,
      status: 'archived',
      metadata: { providerRemovalPendingAt: minute(0) },
    },
    {
      sandboxId: crypto.randomUUID(),
      sessionId: `${SESSION_PREFIX}pending-active`,
      accountId: seeded.account_id,
      projectId: seeded.project_id,
      externalId: 'ext-pending-active',
      status: 'active',
      metadata: { providerRemovalPendingAt: minute(0) },
    },
  ]);
  await db.execute(sql`analyze ${sessionSandboxes}`);
});

afterAll(async () => {
  await cleanupRows();
  await removeSeeded([seeded]);
});

describe('idx_session_sandboxes_provider_removal_pending serves the provider-removal reaper', () => {
  test('the shipped statement plans the partial index instead of a Seq Scan', async () => {
    const plan = await db.execute(sql`EXPLAIN ${removeArchivedProviderBoxesQuery()}`);
    const text = planText(plan);
    expect(text).toContain('idx_session_sandboxes_provider_removal_pending');
    expect(text).not.toContain('Seq Scan');
    // The only index that knew `status` does not carry the reaper's predicate
    // or its ordering: if the plan reaches for it the predicate no longer
    // matches the index.
    expect(text).not.toContain('idx_session_sandboxes_status');
    // The index key is the ORDER BY expression: no Sort node.
    expect(text).not.toContain('Sort');
  });

  test('the index survives a generic plan: status is a key, not a predicate', async () => {
    // The app binds `status` as a parameter. A generic plan cannot prove
    // `status = $1` implies the literal predicate, so a status-PREDICATE
    // variant of this index drops out of the plan once the server switches to
    // generic plans (verified against plan_cache_mode = force_generic_plan —
    // that variant planned a Parallel Seq Scan). This index carries status as
    // the leading key, so the same prepared statement keeps it.
    const { Client } = await import('pg');
    const client = new Client({ connectionString: localTestDatabaseUrl() });
    await client.connect();
    try {
      await client.query('set plan_cache_mode = force_generic_plan');
      await client.query(
        `prepare reaper_generic_plan (kortix.session_sandbox_status, integer) as ${removeArchivedProviderBoxesQuery().toSQL().sql}`,
      );
      try {
        const { rows } = await client.query(
          'explain (format json) execute reaper_generic_plan (\'archived\', 50)',
        );
        const nodes: string[] = [];
        const walk = (node: Record<string, unknown>): void => {
          nodes.push(
            String(node['Node Type']) +
              (node['Index Name'] ? ` ${String(node['Index Name'])}` : ''),
          );
          for (const child of (node['Plans'] as Array<Record<string, unknown>>) ?? []) walk(child);
        };
        walk((rows[0] as { 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> })['QUERY PLAN'][0].Plan);
        const text = nodes.join('\n');
        expect(text).toContain('idx_session_sandboxes_provider_removal_pending');
        expect(text).not.toContain('Seq Scan');
        expect(text).not.toContain('idx_session_sandboxes_status');
      } finally {
        await client.query('deallocate reaper_generic_plan');
      }
    } finally {
      await client.end();
    }
  });

  test('the batch returns only stamped archived rows with an external box, nulls first, limited', async () => {
    const rows = await removeArchivedProviderBoxesQuery();
    expect(rows.length).toBe(BATCH);
    for (const row of rows) {
      expect(row.externalId).toBeTruthy();
      expect((row.metadata as Record<string, unknown>).providerRemovalPendingAt).toBe(minute(0));
    }
    // Never-attempted rows (no retry stamp) sort first, then the stamped ones
    // in lexicographic (= chronological) order of the stored ISO strings.
    const order = rows.map((row) => {
      const value = (row.metadata as Record<string, unknown>).providerRemovalRetryAfterAt;
      return typeof value === 'string' ? value : null;
    });
    const sorted = [...order].sort((a, b) => {
      if (a === b) return 0;
      if (a === null) return -1;
      if (b === null) return 1;
      return a < b ? -1 : 1;
    });
    expect(order).toEqual(sorted);
    expect(order[0]).toBeNull();
  });
});
