/**
 * The parked-runtime verification sweep needs its ordering index.
 *
 * KRTX-1307: `verifyParkedRuntimes`
 * (apps/api/src/projects/reaping/parked-runtime-verification.ts) reads its
 * batch as `WHERE status = <param> AND external_id IS NOT NULL ORDER BY
 * metadata->>'parkedVerifiedAt' ASC NULLS FIRST LIMIT 60`. Without
 * `idx_session_sandboxes_parked_verified` every pass read every `stopped`
 * row with an external id (~45.6k in prod) and sorted them — the Supabase
 * slow-query collector measured a 3027 ms mean over 1704 calls. The
 * `.concurrent.ts` migration builds a composite `(status, expression)` index
 * in exactly that order, with `status` as the leading KEY (the app binds it
 * as a query parameter, so a partial-index predicate on it would drop out of
 * the generic plan).
 *
 * Reads the live catalog and the live planner (EXPLAIN with the app's
 * parameterized shape under `force_generic_plan`); never source text. Mirrors
 * `access-requests-unused-index-drop.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const INDEX_NAME = 'idx_session_sandboxes_parked_verified';
/** The expression column of the index, as pg_get_indexdef spells it. */
const ORDER_EXPRESSION = "((metadata ->> 'parkedVerifiedAt'::text))";
const SWEEP_COLUMNS =
  'sandbox_id, session_id, account_id, project_id, provider, external_id, ' +
  'base_url, status, config, metadata, last_used_at, active_since, ' +
  'deadline_at, created_at, updated_at';

suite('kortix.session_sandboxes parked-verification index (KRTX-1307)', () => {
  const withClient = async (fn: (client: pg.Client) => Promise<void>) => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  };

  test('the migration built a valid index with the sweep shape', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{ indexdef: string }>(
        `select indexdef from pg_indexes
          where schemaname = 'kortix' and tablename = 'session_sandboxes'
            and indexname = $1`,
        [INDEX_NAME],
      );
      expect(rows).toHaveLength(1);
      const def = rows[0].indexdef;
      // `status` is a real key column, not only a WHERE predicate.
      expect(def).toContain('(status,');
      // The ordering matches the sweep's `order by … asc nulls first`
      // (pg_get_indexdef omits the default ASC).
      expect(def).toContain(`${ORDER_EXPRESSION} NULLS FIRST`);
      // The static `external_id IS NOT NULL` predicate shrinks the index.
      expect(def).toContain('WHERE (external_id IS NOT NULL)');
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

  test('the sweep reads its batch from the index in order, with no scan-and-sort', async () => {
    await withClient(async (client) => {
      // Synthetic rows, created and rolled back in one session. The shape:
      // 1200 rows; `stopped` for even g (600), `active` for odd g; of the
      // stopped rows, g % 40 == 0 (30 rows) carry no parkedVerifiedAt and the
      // rest carry `now() - g minutes` — ISO text, unique per g, so
      // chronological order is exactly descending g.
      await client.query('begin');
      try {
        await client.query(
          `insert into kortix.session_sandboxes
             (sandbox_id, session_id, account_id, project_id, external_id, status, metadata)
           select gen_random_uuid(),
                  case
                    when g % 40 = 0 then 'krtx1307-never-' || g::text
                    when g % 2 = 0 then 'krtx1307-done-' || g::text
                    else 'krtx1307-active-' || g::text
                  end,
                  gen_random_uuid(), gen_random_uuid(), 'ext-' || g::text,
                  case when g % 2 = 0 then 'stopped' else 'active' end::kortix.session_sandbox_status,
                  case
                    when g % 40 = 0 then '{}'::jsonb
                    else jsonb_build_object('parkedVerifiedAt',
                         to_char(now() - (g::text || ' minutes')::interval,
                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                  end
           from generate_series(1, 1200) g`,
        );
        // The planner must see the seeded shape: without ANALYZE a freshly
        // migrated table looks empty and the tiny-table plan hides the choice
        // the prod-sized table makes.
        await client.query('analyze kortix.session_sandboxes');
        // The sweep's exact statement shape, with `status` bound as a
        // parameter and planned generically — the way a long-lived
        // node-postgres connection serves every call after the first five.
        // Key assertions are properties, not row ids: the answer must still be
        // the correct top-60 of whatever the database holds.
        await client.query('set plan_cache_mode = force_generic_plan');
        const { rows: sweepRows } = await client.query<{
          session_id: string;
          verified_at: string | null;
        }>(
          `select session_id,
                  (kortix.session_sandboxes.metadata ->> 'parkedVerifiedAt') as verified_at
             from kortix.session_sandboxes
            where (kortix.session_sandboxes.status = $1
                   and kortix.session_sandboxes.external_id is not null)
            order by (kortix.session_sandboxes.metadata ->> 'parkedVerifiedAt') asc nulls first
            limit 60`,
          ['stopped'],
        );
        expect(sweepRows).toHaveLength(60);
        const keys = sweepRows.map((r) => r.verified_at);
        // (a) NULLS FIRST, then ascending: the batch is least-recently-verified.
        const cmp = (a: string | null, b: string | null) =>
          a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
        for (let i = 1; i < keys.length; i++)
          expect(cmp(keys[i - 1], keys[i])).toBeLessThanOrEqual(0);
        // The ordering above is only a real check when the batch spans the
        // null boundary: at least one verified row must be in it.
        expect(keys.some((k) => k !== null)).toBe(true);
        // (b) No qualifying row outside the batch sorts before it: the sweep
        // really reads the head of the order, not an arbitrary cut. Ties at
        // the boundary may fall on either side, so `>=` is the bound.
        const { rows: allRows } = await client.query<{
          session_id: string;
          verified_at: string | null;
        }>(
          `select session_id,
                  (kortix.session_sandboxes.metadata ->> 'parkedVerifiedAt') as verified_at
             from kortix.session_sandboxes
            where (kortix.session_sandboxes.status = $1
                   and kortix.session_sandboxes.external_id is not null)`,
          ['stopped'],
        );
        const returnedIds = new Set(sweepRows.map((r) => r.session_id));
        const maxReturned = keys[keys.length - 1] ?? null;
        for (const row of allRows) {
          if (returnedIds.has(row.session_id)) continue;
          expect(cmp(row.verified_at, maxReturned)).toBeGreaterThanOrEqual(0);
        }

        // And the plan: the index delivers the batch, no full scan, no sort.
        const { rows: planRows } = await client.query<{ 'QUERY PLAN': unknown[] }>(
          `explain (format json, analyze)
           select ${SWEEP_COLUMNS}
             from kortix.session_sandboxes
            where (kortix.session_sandboxes.status = $1
                   and kortix.session_sandboxes.external_id is not null)
            order by (kortix.session_sandboxes.metadata ->> 'parkedVerifiedAt') asc nulls first
            limit 60`,
          ['stopped'],
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
        // The failure the index fixes: a full scan feeding an explicit sort.
        expect(nodeTypes).not.toContain('Seq Scan');
        expect(nodeTypes).not.toContain('Sort');
        expect(nodeTypes).not.toContain('Bitmap Heap Scan');
        expect(nodeTypes).not.toContain('Bitmap Index Scan');
        expect(
          nodes.some(
            (n) =>
              n['Node Type'] === 'Index Scan' &&
              n['Relation Name'] === 'session_sandboxes' &&
              n['Index Name'] === INDEX_NAME,
          ),
        ).toBe(true);
      } finally {
        await client.query('rollback');
      }
    });
  });
});
