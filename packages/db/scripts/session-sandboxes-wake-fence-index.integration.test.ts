/**
 * `kortix.session_sandboxes` wake-fence index (KRTX-1304).
 *
 * `reconcileRuntimeWakeFences` scans this table every maintenance pass for
 * stopped boxes with an open wake fence. Only ~600 of 65450 prod rows carry
 * either key, but the planner's default jsonb-expression selectivities made
 * the statement cost out as "57k of 65k rows match", so it seq-scanned the
 * table on every pass (mean 1540 ms over 11572 calls on the pre-KRTX-267
 * statement shape, 3943 ms over 1278 calls on the current one). The fix is
 * the partial index `idx_session_sandboxes_wake_fence` plus the expression
 * statistics that let the planner cost the index path truthfully.
 *
 * What this suite pins down, reading the live catalog and the real planner:
 *  1. the index and the statistics object exist;
 *  2. the planner PROVES the statement implies the index predicate — with
 *     seq scan disabled the plan must use the wake index. This is the
 *     invariant that silently breaks when someone reshapes the WHERE clause:
 *     a proof the planner no longer accepts leaves a dead index and the old
 *     seq scan;
 *  3. the statement still returns exactly the candidate rows on the real
 *     migrated schema.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The exact WHERE block of `reconcileRuntimeWakeFences` (runtime-wake-maintenance.ts). */
const WAKE_QUERY = `select "sandbox_id", "session_id", "external_id", "provider", "metadata"
  from "kortix"."session_sandboxes"
  where ("kortix"."session_sandboxes"."status" = $1
    and "kortix"."session_sandboxes"."external_id" is not null
    and (
      (
        "kortix"."session_sandboxes"."metadata"->>'runtimeWakeId' IS NOT NULL
        AND ("kortix"."session_sandboxes"."metadata"->>'runtimeWakeLeaseExpiresAt' IS NULL
          OR "kortix"."session_sandboxes"."metadata"->>'runtimeWakeLeaseExpiresAt' !~ '^\\d{4}-\\d{2}-\\d{2}T'
          OR "kortix"."session_sandboxes"."metadata"->>'runtimeWakeLeaseExpiresAt' <= $2)
      )
      OR (
        "kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupUntilAt' ~ '^\\d{4}-\\d{2}-\\d{2}T'
        AND "kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupUntilAt' > $3
        AND "kortix"."session_sandboxes"."metadata"->>'runtimeWakeLateStartStoppedAt' IS NULL
      )
    )
    AND (
      "kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupId' IS NULL
      OR ("kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupLeaseExpiresAt' IS NULL
        OR "kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupLeaseExpiresAt' !~ '^\\d{4}-\\d{2}-\\d{2}T'
        OR "kortix"."session_sandboxes"."metadata"->>'runtimeWakeCleanupLeaseExpiresAt' <= $4)
    ))
  limit $5`;

// One clock per run: the wake lease must read expired and the cleanup guard
// must read still-open relative to the statement's $2-$4, so both OR arms stay
// reachable no matter when the suite runs.
const NOW = new Date();
const NOW_ISO = NOW.toISOString();
const LEASE_EXPIRED_AT = new Date(NOW.getTime() - 3_600_000).toISOString();
const CLEANUP_OPEN_UNTIL = new Date(NOW.getTime() + 300_000).toISOString();
const WAKE_INDEX = 'idx_session_sandboxes_wake_fence';
const WAKE_STATS = 'session_sandboxes_wake_fence_stats';

/** Enough stopped rows that the wake index strictly dominates every other index path. */
const PLAIN_STOPPED_ROWS = 3000;

suite('kortix.session_sandboxes wake-fence index', () => {
  const withClient = async (fn: (client: pg.Client) => Promise<void>) => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  };

  // Seed before the catalog reads: the db-suites lane hands the file a fresh
  // migrated database whose tables are empty, and the statistics view
  // (pg_stats_ext) has no row for the object until an ANALYZE saw data.
  beforeAll(async () => {
    await withClient(seed);
  });

  /**
   * Seed the two candidates and the plain-stopped bulk. Every statement is
   * idempotent (`on conflict do update` / `do nothing` on session_id): the
   * lane hands the suite a fresh database, and a manual re-run against a
   * reused one must stay green. Established identities are immutable per the
   * guard trigger, so the update path only rewrites metadata.
   */
  const seed = async (client: pg.Client) => {
    await client.query(`
      insert into kortix.session_sandboxes
        (sandbox_id, session_id, account_id, project_id, provider, external_id, status, metadata)
      values
        (gen_random_uuid(), 'wake-test-wake-id', gen_random_uuid(), gen_random_uuid(),
          'daytona', 'wake-test-ext-1', 'stopped',
          jsonb_build_object('runtimeWakeId', 'wake-1',
            'runtimeWakeLeaseExpiresAt', '${LEASE_EXPIRED_AT}')),
        (gen_random_uuid(), 'wake-test-cleanup', gen_random_uuid(), gen_random_uuid(),
          'daytona', 'wake-test-ext-2', 'stopped',
          jsonb_build_object('runtimeWakeCleanupUntilAt', '${CLEANUP_OPEN_UNTIL}'))
      on conflict (session_id) do update set metadata = excluded.metadata
    `);
    await client.query(
      `insert into kortix.session_sandboxes
         (sandbox_id, session_id, account_id, project_id, provider, external_id, status, metadata)
       select gen_random_uuid(), 'wake-test-plain-' || g, gen_random_uuid(), gen_random_uuid(),
         'daytona', 'wake-test-plain-ext-' || g, 'stopped',
         jsonb_build_object('stopReason', 'deadline_expired', 'pad', repeat('x', 800))
       from generate_series(1, $1) g
       on conflict (session_id) do nothing`,
      [PLAIN_STOPPED_ROWS],
    );
    // The migration's ANALYZE ran on an empty table (a fresh database applies
    // the chain before any row exists), so the expression statistics hold no
    // data until rows exist and an ANALYZE recomputes them — and the planner
    // needs those numbers to cost the index path truthfully.
    await client.query('analyze kortix.session_sandboxes');
  };
  test('the partial index and its expression statistics exist', async () => {
    await withClient(async (client) => {
      const { rows: indexRows } = await client.query<{ indexdef: string }>(
        `select pg_get_indexdef(c.oid) as indexdef
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'kortix' and c.relname = $1`,
        [WAKE_INDEX],
      );
      expect(indexRows).toHaveLength(1);
      const indexdef = indexRows[0]?.indexdef ?? '';
      expect(indexdef).toContain('ON kortix.session_sandboxes USING btree (external_id)');
      expect(indexdef).toContain("((metadata ->> 'runtimeWakeId'::text) IS NOT NULL)");
      expect(indexdef).toContain(
        "((metadata ->> 'runtimeWakeCleanupUntilAt'::text) ~ '^\\d{4}-\\d{2}-\\d{2}T'::text)",
      );
      expect(indexdef).not.toContain("status = 'stopped'"); // the parameterized qual must stay out

      // pg_stats_ext reads the same catalog the planner matches quals
      // against: both expressions present, mcv kind only.
      const { rows: statRows } = await client.query<{ exprs: string[]; kinds: string[] }>(
        `select exprs, kinds
           from pg_stats_ext
          where statistics_schemaname = 'kortix' and statistics_name = $1`,
        [WAKE_STATS],
      );
      expect(statRows).toHaveLength(1);
      expect(statRows[0]?.exprs).toEqual([
        "(metadata ->> 'runtimeWakeId'::text)",
        "(metadata ->> 'runtimeWakeCleanupUntilAt'::text)",
      ]);
      expect(statRows[0]?.kinds).toEqual('{m,e}');
    });
  });

  test('the planner proves the statement implies the index predicate', async () => {
    await withClient(async (client) => {

      // Seq scan off: the only paths left are index paths, so the plan naming
      // the wake index is the predicate-proof proof, not a cost accident.
      await client.query('set enable_seqscan = off');
      const { rows: planRows } = await client.query<{ 'QUERY PLAN': string }>(
        `explain (costs off) ${WAKE_QUERY}`,
        ['stopped', NOW_ISO, NOW_ISO, NOW_ISO, 100],
      );
      const plan = planRows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toContain(WAKE_INDEX);
      expect(plan).not.toContain('Seq Scan');
    });
  });

  test('the statement returns exactly the wake candidates, in shape and in row set', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ session_id: string }>(WAKE_QUERY, [
        'stopped',
        NOW_ISO,
        NOW_ISO,
        NOW_ISO,
        100,
      ]);
      // The database holds exactly the candidates this file seeds: one row
      // per OR arm, nothing else in candidate state.
      expect(rows.map((r) => r.session_id).sort()).toEqual([
        'wake-test-cleanup',
        'wake-test-wake-id',
      ]);
    });
  });
});
