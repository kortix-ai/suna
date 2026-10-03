/**
 * The archived-box reaper's candidate query on `kortix.session_sandboxes` is
 * answered by `idx_session_sandboxes_provider_removal_pending`.
 *
 * `removeArchivedProviderBoxes` (apps/api/src/projects/reaping/
 * archived-box-removal.ts) runs, on every maintenance tick, a query whose only
 * predicate is `status = 'archived' AND external_id IS NOT NULL AND
 * metadata ? 'providerRemovalPendingAt'` with
 * `ORDER BY metadata->>'providerRemovalRetryAfterAt' ASC NULLS FIRST LIMIT 50`.
 * Before the index it scanned every archived row's metadata (a jsonb `?` check
 * over ~4.4k rows and their TOAST payloads in prod) and sorted the survivors —
 * minutes of cumulative DB time per day, usually to return zero rows. The
 * partial index carries the query's own predicate, so it only ever holds rows
 * the reaper can act on, and its key is the ORDER BY expression with matching
 * NULLS FIRST, so the LIMIT reads the due rows straight off the index.
 *
 * Reads the live catalog and the live planner against the freshly migrated
 * database, never source text; mirrors
 * `account-secret-resources-fk-index.integration.test.ts`.
 *
 *   TEST_DATABASE_URL=postgres://… bun test packages/db/scripts/session-sandboxes-provider-removal-index.integration.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** The reaper's metadata stamp key (PROVIDER_REMOVAL_PENDING_KEY). */
const PENDING_KEY = 'providerRemovalPendingAt';
/** The reaper's backoff stamp key, and the query's sort key. */
const RETRY_KEY = 'providerRemovalRetryAfterAt';
const INDEX_NAME = 'idx_session_sandboxes_provider_removal_pending';

/** The reaper's candidate query, parameters inlined. */
const REAPER_QUERY = `
  select sandbox_id, external_id, provider, metadata
    from kortix.session_sandboxes
   where status = 'archived'
     and external_id is not null
     and metadata ? '${PENDING_KEY}'
   order by metadata->>'${RETRY_KEY}' asc nulls first
   limit 50
`;

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

/** One row of `explain (format json)`: the plan tree under `Plan`. */
interface ExplainRow {
  'QUERY PLAN': Array<{ Plan: PlanNode }>;
}

suite(`kortix.session_sandboxes ${INDEX_NAME}`, () => {
  // One fresh client per use: a pg Client cannot reconnect after end().
  const withClient = async (fn: (client: pg.Client) => Promise<void>) => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  };

  // The lane gives this file a fresh migrated database; the guard trigger
  // kortix.guard_session_sandbox_identity() refuses to delete a sandbox row
  // that carries a provider identity, so the seed never deletes: the prefix is
  // unique per run, and the seed runs once.
  const prefix = `reaper-seed-${Date.now()}-${process.pid}`;
  beforeAll(async () => {
    await withClient(async (client) => {
      await client.query(`
        insert into kortix.session_sandboxes
          (sandbox_id, session_id, account_id, project_id, provider, external_id, status, metadata)
        select
          gen_random_uuid(),
          '${prefix}-bulk-' || g,
          gen_random_uuid(),
          gen_random_uuid(),
          'daytona',
          'ext-' || g,
          'archived',
          jsonb_build_object(
            'runtimeRestartId', gen_random_uuid()::text,
            'activeTurns', jsonb_build_array(jsonb_build_object('id', gen_random_uuid()::text)),
            'payload', repeat('x', 700)
          )
        from generate_series(1, 6000) g
      `);
      // One due row with no retry stamp (sorts first: NULLS FIRST), one already
      // due, one still backed off, and one archived row without the stamp that
      // the query must never return.
      await client.query(`
        insert into kortix.session_sandboxes
          (sandbox_id, session_id, account_id, project_id, provider, external_id, status, metadata)
        values
          (gen_random_uuid(), '${prefix}-null-retry', gen_random_uuid(), gen_random_uuid(), 'daytona', 'ext-null-retry', 'archived',
            jsonb_build_object('${PENDING_KEY}', now()::text)),
          (gen_random_uuid(), '${prefix}-due', gen_random_uuid(), gen_random_uuid(), 'daytona', 'ext-due', 'archived',
            jsonb_build_object('${PENDING_KEY}', now()::text, '${RETRY_KEY}', '2026-01-01T00:00:00Z')),
          (gen_random_uuid(), '${prefix}-backoff', gen_random_uuid(), gen_random_uuid(), 'daytona', 'ext-backoff', 'archived',
            jsonb_build_object('${PENDING_KEY}', now()::text, '${RETRY_KEY}', '2999-01-01T00:00:00Z')),
          (gen_random_uuid(), '${prefix}-plain', gen_random_uuid(), gen_random_uuid(), 'daytona', 'ext-plain', 'archived',
            jsonb_build_object('note', 'no stamp'))
      `);
      await client.query('analyze kortix.session_sandboxes');
    });
  }, 60_000);

  const walkPlan = (node: PlanNode, visit: (n: PlanNode) => void): void => {
    visit(node);
    for (const child of node.Plans ?? []) walkPlan(child, visit);
  };

  test('the index exists, is valid, and carries the reaper predicate and ordering', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{
        definition: string;
        valid: boolean;
      }>(`
        select pg_get_indexdef(i.indexrelid, 0, true) as definition, i.indisvalid as valid
          from pg_index i
          join pg_class c on c.oid = i.indexrelid
         where c.relname = '${INDEX_NAME}'
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0].valid).toBe(true);
      // pg_get_indexdef decorates literals with casts and drops a redundant
      // ASC; strip both so the assertion holds across renderings.
      const definition = rows[0].definition
        .toLowerCase()
        .replace(/::[a-z_.]+/g, '')
        .replace(/\s+/g, ' ');
      // The key is the ORDER BY expression, with the query's NULLS FIRST.
      expect(definition).toContain(`(metadata ->> '${RETRY_KEY.toLowerCase()}') nulls first`);
      // The predicate is the query's own WHERE clause.
      expect(definition).toContain(
        `where status = 'archived' and external_id is not null and metadata ? '${PENDING_KEY.toLowerCase()}'`,
      );
    });
  });

  test('the reaper query reads the partial index, not every archived row', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<ExplainRow>(`explain (format json) ${REAPER_QUERY}`);
      const root = rows[0]['QUERY PLAN'][0].Plan;
      expect(root).toBeDefined();

      const nodes: PlanNode[] = [];
      walkPlan(root, (n) => nodes.push(n));

      // The partial index answers the query.
      expect(nodes.some((n) => n['Index Name'] === INDEX_NAME)).toBe(true);
      // No scan of the whole table: the old plan read all ~6k archived rows
      // through idx_session_sandboxes_status (or a seq scan) and filtered.
      expect(
        nodes.filter(
          (n) =>
            (n['Node Type'] === 'Seq Scan' && n['Relation Name'] === 'session_sandboxes') ||
            n['Index Name'] === 'idx_session_sandboxes_status',
        ),
      ).toEqual([]);
      // The index key carries the ORDER BY: the plan must not sort.
      expect(nodes.some((n) => n['Node Type'] === 'Sort')).toBe(false);
    });
  });

  test('the reaper query returns the due rows, unstamped retry first (nulls first)', async () => {
    await withClient(async (client) => {
      const { rows } = await client.query<{
        external_id: string;
        metadata: Record<string, unknown>;
      }>(REAPER_QUERY);
      const ids = rows.map((r) => r.external_id);
      // Every returned row carries the stamp — the predicate holds. The plain
      // archived row and the 6000 unstamped bulk rows never appear. The query
      // may also return stamped rows from other seeds (the lane runs this file
      // on a fresh database, so here that is the three below).
      expect(rows.every((r) => PENDING_KEY in (r.metadata ?? {}))).toBe(true);
      expect(ids).not.toContain('ext-plain');
      expect(rows.some((r) => /^ext-\d+$/.test(r.external_id))).toBe(false);
      // The stamped rows come back in retry-after order, the row with no
      // retry stamp first: ASC NULLS FIRST.
      const nullRetry = ids.indexOf('ext-null-retry');
      const due = ids.indexOf('ext-due');
      const backoff = ids.indexOf('ext-backoff');
      expect(nullRetry).toBeGreaterThanOrEqual(0);
      expect(nullRetry).toBeLessThan(due);
      expect(due).toBeLessThan(backoff);
      expect(rows.length).toBeLessThanOrEqual(50);
    });
  });
});
