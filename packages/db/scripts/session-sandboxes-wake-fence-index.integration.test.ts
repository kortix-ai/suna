/**
 * The runtime wake-fence reconcile needs its partial index.
 *
 * KRTX-1304: `reconcileRuntimeWakeFences`
 * (apps/api/src/projects/session-lifecycle/runtime-wake-maintenance.ts) reads
 * `stopped` boxes with an external id and keeps only the handful whose wake
 * fence is open — an expired `runtimeWakeId` lease or a live
 * `runtimeWakeCleanupUntilAt` late-start window, and no open cleanup lease.
 * Every fence branch requires one of those two metadata keys, so without
 * `idx_session_sandboxes_wake_fences` the statement visits every
 * `stopped`-with-external row (~57.7k in prod) and evaluates six
 * `metadata->>'…'` extractions and two regexes per row — the Supabase
 * slow-query collector measured a 1540 ms mean over 11572 calls. The partial
 * index holds only rows a wake ever fenced (502 in prod on 2026-10-03).
 *
 * Reads the live catalog and the live planner (EXPLAIN with the app's
 * parameterized shape under both `force_generic_plan` and the literal plan
 * drizzle's unnamed statements plan every call); never source text. The
 * statement itself runs against seeded rows that pin the fence semantics:
 * exactly the open-fence rows come back, stale/open-lease/cleanup-claimed
 * rows do not — so a predicate written too tightly fails here instead of
 * silently dropping wake candidates. Mirrors
 * access-requests-unused-index-drop.integration.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const INDEX_NAME = 'idx_session_sandboxes_wake_fences';
const STMT_COLUMNS = 'sandbox_id, session_id, external_id, provider, metadata';
/**
 * The statement's WHERE shape, exactly as `reconcileRuntimeWakeFences` builds
 * it: `status` and the deadline bound as parameters, plus the `?|` fence-key
 * clause the statement carries so the partial index's predicate matches it
 * clause-for-clause and the planner can estimate it (Postgres cannot estimate
 * key presence from a `->>'…' IS NOT NULL` clause; it estimates `?|` at
 * ~0.8 % of the table).
 */
const STMT_WHERE = `(kortix.session_sandboxes.status = $1::kortix.session_sandbox_status
        and kortix.session_sandboxes.external_id is not null
        and kortix.session_sandboxes.metadata ?| array['runtimeWakeId', 'runtimeWakeCleanupUntilAt']
        and (
          (
            (kortix.session_sandboxes.metadata->>'runtimeWakeId' IS NOT NULL
             AND (kortix.session_sandboxes.metadata->>'runtimeWakeLeaseExpiresAt' IS NULL
                  OR (kortix.session_sandboxes.metadata->>'runtimeWakeLeaseExpiresAt') !~ '^\\d{4}-\\d{2}-\\d{2}T'
                  OR (kortix.session_sandboxes.metadata->>'runtimeWakeLeaseExpiresAt') <= $2))
            OR
            ((kortix.session_sandboxes.metadata->>'runtimeWakeCleanupUntilAt' ~ '^\\d{4}-\\d{2}-\\d{2}T')
             AND (kortix.session_sandboxes.metadata->>'runtimeWakeCleanupUntilAt') > $2
             AND (kortix.session_sandboxes.metadata->>'runtimeWakeLateStartStoppedAt' IS NULL))
          )
          AND (
            (kortix.session_sandboxes.metadata->>'runtimeWakeCleanupId' IS NULL)
            OR
            ((kortix.session_sandboxes.metadata->>'runtimeWakeCleanupLeaseExpiresAt' IS NULL
              OR (kortix.session_sandboxes.metadata->>'runtimeWakeCleanupLeaseExpiresAt') !~ '^\\d{4}-\\d{2}-\\d{2}T'
              OR (kortix.session_sandboxes.metadata->>'runtimeWakeCleanupLeaseExpiresAt') <= $2))
          )
        ))`;

/** ISO text the way the app writes it, offset from now (fence metadata is text). */
const iso = (offset: string) => `to_char(now() ${offset}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

suite('kortix.session_sandboxes wake-fence index (KRTX-1304)', () => {
  const withClient = async (fn: (client: pg.Client) => Promise<void>) => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  };

  test('the migration built a valid index with the reconcile shape', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'kortix' and tablename = 'session_sandboxes'
            and indexname = $1`,
        [INDEX_NAME],
      );
      expect(rows).toHaveLength(1);
      const def = rows[0].indexdef;
      // `status` is a real key column, not only a WHERE predicate: the app
      // binds it as a parameter, and a partial-index predicate cannot
      // reference a parameter.
      expect(def).toContain('USING btree (status) WHERE');
      // The static predicates shrink the index to rows a wake ever fenced.
      expect(def).toContain('(external_id IS NOT NULL)');
      expect(def).toContain(
        "metadata ?| ARRAY['runtimeWakeId'::text, 'runtimeWakeCleanupUntilAt'::text]",
      );
      const { rows: validity } = await client.query<{ indisvalid: boolean }>(
        `select i.indisvalid from pg_index i
          join pg_class c on c.oid = i.indexrelid
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'kortix' and c.relname = $1`,
        [INDEX_NAME],
      );
      expect(validity[0].indisvalid).toBe(true);
    });
  });

  test('the reconcile reads only fence rows, and returns exactly the open fences', async () => {
    await withClient(async (client) => {
      // Synthetic rows, created and rolled back in one session, shaped like
      // prod (2026-10-03: 57.7k stopped-with-external rows, 502 of them
      // carrying a fence key — all stale cleanup windows, none an open
      // wake; ~1.3 kB rows): 60000 stopped boxes with an external id and no
      // fence keys, 6000 active ones, and 495 stopped boxes with a STALE
      // cleanup window and its late-start stop stamp — the index's resident
      // mass. The 900-byte pad reproduces prod's row width: the planner's
      // jsonb-key selectivity defaults are unselective (~84 % pass), so the
      // Seq-Scan-vs-index choice is driven by the table's real page count;
      // skinny synthetic rows make it a knife-edge the prod table is not.
      // The two open-fence rows and five closed-fence negatives pin every
      // branch of the reconcile predicate. This statement has no ORDER BY,
      // so at a small scale the planner seq-scans the whole table and hides
      // the choice the prod-sized table makes. Seeded timestamps sit two
      // hours away from the executed deadline (+1 h) so a slow runner cannot
      // cross them.
      await client.query('begin');
      try {
        await client.query(
          `insert into kortix.session_sandboxes
             (sandbox_id, session_id, account_id, project_id, external_id, status, metadata)
           select gen_random_uuid(), 'krtx1304-bulk-' || g::text,
                  gen_random_uuid(), gen_random_uuid(), 'ext-bulk-' || g::text,
                  case when g % 11 = 0 then 'active' else 'stopped' end::kortix.session_sandbox_status,
                  jsonb_build_object('pad', repeat('x', 900))
           from generate_series(1, 66000) g`,
        );
        await client.query(
          `insert into kortix.session_sandboxes
             (sandbox_id, session_id, account_id, project_id, external_id, status, metadata)
           select gen_random_uuid(), 'krtx1304-stale-' || g::text,
                  gen_random_uuid(), gen_random_uuid(), 'ext-stale-' || g::text,
                  'stopped',
                  jsonb_build_object('pad', repeat('x', 900),
                                     'runtimeWakeCleanupUntilAt', ${iso("- interval '2 hours'")},
                                     'runtimeWakeLateStartStoppedAt', ${iso("- interval '3 hours'")})
           from generate_series(1, 495) g`,
        );
        await client.query(
          `insert into kortix.session_sandboxes
             (sandbox_id, session_id, account_id, project_id, external_id, status, metadata)
           values
             -- open expired wake lease: the reconcile's branch 1
             (gen_random_uuid(), 'krtx1304-claim-expired', gen_random_uuid(), gen_random_uuid(),
              'ext-claim-expired', 'stopped',
              jsonb_build_object('runtimeWakeId', 'wake-a',
                                 'runtimeWakeStartedAt', ${iso("- interval '2 hours'")},
                                 'runtimeWakeLeaseExpiresAt', ${iso("- interval '1 hour'")})),
             -- live late-start cleanup window, no stop stamp: branch 2
             (gen_random_uuid(), 'krtx1304-cleanup-live', gen_random_uuid(), gen_random_uuid(),
              'ext-cleanup-live', 'stopped',
              jsonb_build_object('runtimeWakeCleanupUntilAt', ${iso("+ interval '2 hours'")})),
             -- late start already stopped: branch 2 closed
             (gen_random_uuid(), 'krtx1304-late-stopped', gen_random_uuid(), gen_random_uuid(),
              'ext-late-stopped', 'stopped',
              jsonb_build_object('runtimeWakeCleanupUntilAt', ${iso("+ interval '2 hours'")},
                                 'runtimeWakeLateStartStoppedAt', ${iso("- interval '1 hour'")})),
             -- wake lease still open: branch 1 closed
             (gen_random_uuid(), 'krtx1304-lease-live', gen_random_uuid(), gen_random_uuid(),
              'ext-lease-live', 'stopped',
              jsonb_build_object('runtimeWakeId', 'wake-b',
                                 'runtimeWakeStartedAt', ${iso("- interval '1 minute'")},
                                 'runtimeWakeLeaseExpiresAt', ${iso("+ interval '2 hours'")})),
             -- another worker holds the cleanup lease: the trailing clause closes it
             (gen_random_uuid(), 'krtx1304-cleanup-claimed', gen_random_uuid(), gen_random_uuid(),
              'ext-cleanup-claimed', 'stopped',
              jsonb_build_object('runtimeWakeCleanupUntilAt', ${iso("+ interval '2 hours'")},
                                 'runtimeWakeCleanupId', 'cleanup-x',
                                 'runtimeWakeCleanupLeaseExpiresAt', ${iso("+ interval '2 hours'")})),
             -- fence keys on a live box: wrong status
             (gen_random_uuid(), 'krtx1304-active-fenced', gen_random_uuid(), gen_random_uuid(),
              'ext-active-fenced', 'active',
              jsonb_build_object('runtimeWakeId', 'wake-c',
                                 'runtimeWakeLeaseExpiresAt', ${iso("- interval '1 hour'")})),
             -- fence keys but no external id: nothing to ask the provider about
             (gen_random_uuid(), 'krtx1304-no-external', gen_random_uuid(), gen_random_uuid(),
              null, 'stopped',
              jsonb_build_object('runtimeWakeCleanupUntilAt', ${iso("+ interval '2 hours'")}))`,
        );
        // The planner must see the seeded shape: without ANALYZE a freshly
        // migrated table looks empty and the tiny-table plan hides the choice
        // the prod-sized table makes.
        await client.query('analyze kortix.session_sandboxes');

        const deadline = new Date(Date.now() + 3_600_000).toISOString();
        for (const mode of ['force_generic_plan', 'force_custom_plan'] as const) {
          await client.query(`set plan_cache_mode = ${mode}`);
          await client.query('deallocate all');
          await client.query(
            `prepare stmt(text, text) as
               select ${STMT_COLUMNS} from kortix.session_sandboxes where ${STMT_WHERE} limit 100`,
          );
          // (a) Semantics: exactly the two open-fence rows, whichever way the
          // plan is built. A partial index written too tightly would drop
          // one of these two rows here. EXECUTE's arguments are inlined
          // because the extended protocol carries no bind parameters for
          // utility statements.
          const { rows } = await client.query<{ session_id: string }>(
            `execute stmt('stopped', '${deadline}')`,
          );
          expect([...rows.map((r) => r.session_id)].sort()).toEqual([
            'krtx1304-claim-expired',
            'krtx1304-cleanup-live',
          ]);

          // (b) Plan: the index delivers the scan in both plan modes — no
          // walk over every stopped box, and the rows the scan touches are
          // the fence slice, not the bulk.
          const plan = (
            await client.query<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>(
              `explain (analyze, format json) execute stmt('stopped', '${deadline}')`,
            )
          ).rows[0]['QUERY PLAN'][0].Plan;
          const nodes: Record<string, unknown>[] = [];
          const walk = (node: Record<string, unknown>) => {
            nodes.push(node);
            for (const child of (node.Plans as Record<string, unknown>[] | undefined) ?? [])
              walk(child);
          };
          walk(plan);
          if (process.env.DEBUG_PLAN)
            console.log(
              mode,
              JSON.stringify(
                nodes.map((n) => [
                  n['Node Type'],
                  n['Plan Rows'],
                  n['Total Cost'],
                  n['Actual Rows'],
                  n['Rows Removed by Filter'],
                  n['Index Name'],
                ]),
              ),
            );
          const nodeTypes = nodes.map((n) => n['Node Type']);
          // The failure the index fixes: a scan over every stopped box.
          expect(nodeTypes).not.toContain('Seq Scan');
          expect(
            nodes.some(
              (n) =>
                n['Node Type'] === 'Index Scan' &&
                n['Relation Name'] === 'session_sandboxes' &&
                n['Index Name'] === INDEX_NAME,
            ),
          ).toBe(true);
          const scan = nodes.find(
            (n) => n['Node Type'] === 'Index Scan' && n['Index Name'] === INDEX_NAME,
          ) as { 'Actual Rows': number; 'Rows Removed by Filter': number };
          // The index holds ~500 fence rows (the stale mass plus the seven
          // pinned rows); the table holds 66000 stopped-with-external rows.
          // Both numbers come from the plan itself, so the bound fails
          // loudly if the planner ever walks the bulk again.
          expect(scan['Actual Rows'] + scan['Rows Removed by Filter']).toBeLessThan(1000);
        }
      } finally {
        await client.query('rollback');
      }
    });
  }, 60_000);
});
