/**
 * The runtime-wake fence reconcile needs its candidate indexes.
 *
 * KRTX-1308: `reconcileRuntimeWakeFences`
 * (apps/api/src/projects/session-lifecycle/runtime-wake-maintenance.ts) reads
 * its batch as `WHERE status = <param> AND external_id IS NOT NULL AND
 * ((metadata->>'runtimeWakeId' IS NOT NULL AND <wake-lease open>) OR
 * (metadata->>'runtimeWakeCleanupUntilAt' ~ <ISO regex> AND > <param> AND
 * metadata->>'runtimeWakeLateStartStoppedAt' IS NULL)) AND (cleanupId IS NULL
 * OR <cleanup-lease open>) LIMIT 100`. The candidate set is nearly always
 * empty, yet every maintenance pass scanned every `stopped` row with an
 * external id (~45.6k in prod) and evaluated the jsonb predicates on it — the
 * Supabase slow-query collector measured a mean of 3964 ms over 1075 calls.
 * The two `.concurrent.ts` migrations build one composite `(status,
 * expression)` index per OR arm so the planner serves the arms as a BitmapOr
 * and rechecks the lease conditions on the handful of candidates. `status` is
 * the leading KEY (the app binds it as a query parameter, so a partial-index
 * predicate on it would drop out of the generic plan) and NOT partial on
 * `external_id IS NOT NULL` — the planner needs the whole-table null fraction
 * of each indexed expression to estimate the OR arms rare enough to pick the
 * BitmapOr, and partial-index statistics are not used for that estimate.
 *
 * Reads the live catalog and the live planner (EXPLAIN with the app's
 * parameterized shape under `force_generic_plan`); never source text. Mirrors
 * `session-sandboxes-parked-verified-index.integration.test.ts` (KRTX-1307,
 * the sibling index on the same table and collector).
 *
 *   TEST_DATABASE_URL=postgres://… bun test packages/db/scripts/session-sandboxes-runtime-wake-index.integration.test.ts
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const ARM_A_INDEX = 'idx_session_sandboxes_wake_id';
const ARM_B_INDEX = 'idx_session_sandboxes_wake_cleanup_until';
const INDEXES = [
  { name: ARM_A_INDEX, expression: "((metadata ->> 'runtimeWakeId'::text))" },
  { name: ARM_B_INDEX, expression: "((metadata ->> 'runtimeWakeCleanupUntilAt'::text))" },
];

/** The exact statement shape `reconcileRuntimeWakeFences` sends, parameters bound. */
const WAKE_QUERY = `select "sandbox_id", "session_id", "external_id", "provider", "metadata" from "kortix"."session_sandboxes" where ("kortix"."session_sandboxes"."status" = $1 and "kortix"."session_sandboxes"."external_id" is not null and (
          (
            "kortix"."session_sandboxes"."metadata"->>'runtimeWakeId' IS NOT NULL
            AND ("kortix"."session_sandboxes"."metadata"->>'runtimeWakeLeaseExpiresAt' IS NULL OR "kortix"."session_sandboxes"."metadata"->>'runtimeWakeLeaseExpiresAt' !~ '^\\d{4}-\\d{2}-\\d{2}T' OR "kortix"."session_sandboxes"."metadata"->>'runtimeWakeLeaseExpiresAt' <= $2)
          )
          OR (
            "kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupUntilAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
            AND "kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupUntilAt' > $3
            AND "kortix"."session_sandboxes"."metadata"->>'runtimeWakeLateStartStoppedAt' IS NULL
          )
        )
        AND (
          "kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupId' IS NULL
          OR ("kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupLeaseExpiresAt' IS NULL OR "kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupLeaseExpiresAt' !~ '^\\d{4}-\\d{2}-\\d{2}T' OR "kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupLeaseExpiresAt' <= $4)
        )) limit $5`;

/** `now` for the seeded candidates: leases in its past are open, future ones held. */
const NOW = '2026-10-06T21:00:00.000Z';

suite('kortix.session_sandboxes runtime-wake indexes (KRTX-1308)', () => {
  const withClient = async (fn: (client: pg.Client) => Promise<void>) => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  };

  test('the migrations built both arm indexes with the reconcile shape', async () => {
    await withClient(async (client) => {
      for (const index of INDEXES) {
        const { rows } = await client.query<{ indexdef: string }>(
          `select indexdef from pg_indexes
            where schemaname = 'kortix' and tablename = 'session_sandboxes'
              and indexname = $1`,
          [index.name],
        );
        expect(rows).toHaveLength(1);
        const def = rows[0].indexdef;
        // `status` is a real key column, not only a WHERE predicate.
        expect(def).toContain('(status,');
        // The expression is the OR arm's own metadata key. NOT partial on
        // `external_id IS NOT NULL`: the planner needs the whole-table null
        // fraction of this expression to estimate the arm rare enough to pick
        // the BitmapOr (partial-index statistics are not used globally).
        expect(def).toContain(index.expression);
        expect(def).not.toContain('WHERE');
        const { rows: validity } = await client.query<{ indisvalid: boolean }>(
          `select i.indisvalid from pg_index i
            join pg_class c on c.oid = i.indexrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'kortix' and c.relname = $1`,
          [index.name],
        );
        expect(validity[0].indisvalid).toBe(true);
      }
    });
  });

  test('the reconcile reads its candidates from the arm indexes, not a stopped-row scan', async () => {
    await withClient(async (client) => {
      // Synthetic rows, created and rolled back in one session. The shape:
      // a stopped bulk the size of the prod scan (thousands of `stopped` rows
      // with an external id and no wake keys at all), other statuses, and the
      // handful of wake candidates with their negative variants.
      await client.query('begin');
      try {
        await client.query(
          `insert into kortix.session_sandboxes
             (sandbox_id, session_id, account_id, project_id, external_id, status, metadata)
           select gen_random_uuid(),
                  case
                    when g % 2 = 0 then 'krtxwaket-stopped-' || g::text
                    when g % 3 = 1 then 'krtxwaket-active-' || g::text
                    else 'krtxwaket-archived-' || g::text
                  end,
                  gen_random_uuid(), gen_random_uuid(),
                  case when g % 2 = 0 then 'ext-' || g::text end,
                  case
                    when g % 2 = 0 then 'stopped'
                    when g % 3 = 1 then 'active'
                    else 'archived'
                  end::kortix.session_sandbox_status,
                  jsonb_build_object('stopReason', 'deadline_expired')
           from generate_series(1, 6000) g`,
        );
        await client.query(
          `insert into kortix.session_sandboxes
             (sandbox_id, session_id, account_id, project_id, external_id, status, metadata)
           values
             -- arm A positives: a wake id whose lease is open (expired, absent, malformed)
             (gen_random_uuid(), 'krtxwaket-a-expired-1', gen_random_uuid(), gen_random_uuid(), 'ext-p1', 'stopped',
              jsonb_build_object('runtimeWakeId', 'wake-1', 'runtimeWakeLeaseExpiresAt', '2026-10-06T20:00:00.000Z')),
             (gen_random_uuid(), 'krtxwaket-a-absent-2', gen_random_uuid(), gen_random_uuid(), 'ext-p2', 'stopped',
              jsonb_build_object('runtimeWakeId', 'wake-2')),
             -- arm A + arm B overlap: both arms name the same row
             (gen_random_uuid(), 'krtxwaket-both-3', gen_random_uuid(), gen_random_uuid(), 'ext-p3', 'stopped',
              jsonb_build_object('runtimeWakeId', 'wake-3', 'runtimeWakeLeaseExpiresAt', '2026-10-06T20:00:00.000Z',
                                 'runtimeWakeCleanupUntilAt', '2026-10-06T22:00:00.000Z')),
             -- arm B positives: a future cleanup window with no late-start stamp
             (gen_random_uuid(), 'krtxwaket-b-future-4', gen_random_uuid(), gen_random_uuid(), 'ext-p4', 'stopped',
              jsonb_build_object('runtimeWakeCleanupUntilAt', '2026-10-06T22:00:00.000Z')),
             (gen_random_uuid(), 'krtxwaket-b-future-5', gen_random_uuid(), gen_random_uuid(), 'ext-p5', 'stopped',
              jsonb_build_object('runtimeWakeCleanupUntilAt', '2026-10-07T02:00:00.000Z')),
             -- arm A negative: another claimant holds the wake lease
             (gen_random_uuid(), 'krtxwaket-n-held-lease-6', gen_random_uuid(), gen_random_uuid(), 'ext-n1', 'stopped',
              jsonb_build_object('runtimeWakeId', 'wake-6', 'runtimeWakeLeaseExpiresAt', '2026-10-06T23:00:00.000Z')),
             -- arm B negatives: the window passed, or the late-start stamp already landed
             (gen_random_uuid(), 'krtxwaket-n-past-window-7', gen_random_uuid(), gen_random_uuid(), 'ext-n2', 'stopped',
              jsonb_build_object('runtimeWakeCleanupUntilAt', '2026-10-06T19:00:00.000Z')),
             (gen_random_uuid(), 'krtxwaket-n-latestamp-8', gen_random_uuid(), gen_random_uuid(), 'ext-n3', 'stopped',
              jsonb_build_object('runtimeWakeCleanupUntilAt', '2026-10-06T22:00:00.000Z',
                                 'runtimeWakeLateStartStoppedAt', '2026-10-06T20:00:00.000Z')),
             -- third conjunct negative: a future cleanup lease holds the row
             (gen_random_uuid(), 'krtxwaket-n-held-cleanup-9', gen_random_uuid(), gen_random_uuid(), 'ext-n4', 'stopped',
              jsonb_build_object('runtimeWakeCleanupUntilAt', '2026-10-06T22:00:00.000Z',
                                 'runtimeWakeCleanupId', 'c-9', 'runtimeWakeCleanupLeaseExpiresAt', '2026-10-06T23:00:00.000Z')),
             -- wrong status / no external id / garbage values: the index must not widen the answer
             (gen_random_uuid(), 'krtxwaket-n-wrongstatus-10', gen_random_uuid(), gen_random_uuid(), 'ext-n5', 'active',
              jsonb_build_object('runtimeWakeId', 'wake-10')),
             (gen_random_uuid(), 'krtxwaket-n-noexternal-11', gen_random_uuid(), gen_random_uuid(), null, 'stopped',
              jsonb_build_object('runtimeWakeId', 'wake-11')),
             (gen_random_uuid(), 'krtxwaket-n-garbage-12', gen_random_uuid(), gen_random_uuid(), 'ext-n6', 'stopped',
              jsonb_build_object('runtimeWakeCleanupUntilAt', 'not-a-date', 'runtimeWakeLeaseExpiresAt', 'nope'))`,
        );
        // The planner must see the seeded shape: without ANALYZE a freshly
        // migrated table looks empty and the tiny-table plan hides the choice
        // the prod-sized table makes.
        await client.query('analyze kortix.session_sandboxes');
        // The reconcile's exact statement, with `status` bound as a parameter
        // and planned generically — the way a long-lived node-postgres
        // connection serves every call after the first five.
        await client.query('set plan_cache_mode = force_generic_plan');
        const { rows: wakeRows } = await client.query<{ session_id: string }>(WAKE_QUERY, [
          'stopped',
          NOW,
          NOW,
          NOW,
          100,
        ]);
        // Every candidate must come back, none of the negatives, none of the
        // bulk: the indexes only pre-filter, they never change the answer.
        // (Property assertions, not an exact id set: the database may hold
        // other rows from earlier work.)
        const ids = new Set(wakeRows.map((r) => r.session_id));
        for (const positive of [
          'krtxwaket-a-absent-2',
          'krtxwaket-a-expired-1',
          'krtxwaket-b-future-4',
          'krtxwaket-b-future-5',
          'krtxwaket-both-3',
        ])
          expect(ids.has(positive)).toBe(true);
        for (const negative of [
          'krtxwaket-n-held-lease-6',
          'krtxwaket-n-past-window-7',
          'krtxwaket-n-latestamp-8',
          'krtxwaket-n-held-cleanup-9',
          'krtxwaket-n-wrongstatus-10',
          'krtxwaket-n-noexternal-11',
          'krtxwaket-n-garbage-12',
          'krtxwaket-stopped-2',
          'krtxwaket-archived-3',
        ])
          expect(ids.has(negative)).toBe(false);

        const { rows: planRows } = await client.query<{ 'QUERY PLAN': unknown[] }>(
          `explain (format json, analyze) ${WAKE_QUERY}`,
          ['stopped', NOW, NOW, NOW, 100],
        );
        // Walk the parsed plan: string matching the JSON is brittle around
        // the exact spacing JSON.stringify happens to emit.
        const nodes: Record<string, unknown>[] = [];
        const walk = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? [])
            walk(child);
        };
        walk(planRows[0]['QUERY PLAN'][0].Plan as Record<string, unknown>);
        const nodeTypes = nodes.map((n) => n['Node Type']);
        // The failure the indexes fix: a full scan of the table (or of every
        // stopped row) feeding the jsonb predicate.
        expect(nodeTypes).not.toContain('Seq Scan');
        // No scan reaches for the wide indexes the OR arms used to fall back
        // to (the plain status index or the sibling parked-verified index): a
        // scan through either means the arms were not extracted and the old
        // stopped-row scan is back.
        const wideScans = nodes.filter((n) =>
          ['idx_session_sandboxes_status', 'idx_session_sandboxes_parked_verified'].includes(
            String(n['Index Name']),
          ),
        );
        expect(wideScans).toEqual([]);
        // The OR arms must be served by their own indexes: at least one scan
        // reads an arm index (a BitmapOr member, or a single-arm index scan).
        const armScans = nodes.filter((n) => INDEXES.some((i) => n['Index Name'] === i.name));
        expect(armScans.length).toBeGreaterThan(0);
        // The candidate set is tiny by design: the heap fetch that the plan
        // actually pays for is bounded by the candidates plus their in-index
        // negatives. If it approaches the bulk again, a bulk-wide scan is
        // back (the prod failure mode this PR removes).
        const heapRows = nodes
          .filter((n) => n['Node Type'] === 'Bitmap Heap Scan')
          .reduce((sum, n) => sum + Number(n['Actual Rows'] ?? 0), 0);
        expect(heapRows).toBeLessThanOrEqual(60);
      } finally {
        await client.query('rollback');
      }
    });
  });
});
