/**
 * The audit reconciliation's per-account window is index-driven on every
 * source ledger.
 *
 * `reconcileAuditEvents` (apps/api/src/shared/audit-reconciliation.ts) scans
 * each source ledger with `account_id = $1 AND <time> >= $since` — and, where
 * a row can change after creation, `created_at >= $since OR <second time>
 * >= $since`. Without a composite index per arm, every arm degraded to
 * "heap-fetch the account's WHOLE history through the bare (account_id)
 * index": 58k lifecycle-command rows (payload TOAST included) or 937k
 * connector calls per pass for the largest accounts, 5–10 s of
 * IO/DataFileRead per pass, regular 25 s statement timeouts, and — while a
 * scan ran — every other query on the instance slowed behind it. That
 * fleet-wide DB stall is the p95 tail on `GET /v1/runtime-assets/chunk/:id`
 * (KRTX-797): the route's own work is auth plus a 1 MiB positional read, and
 * every >1 s request spent ~all of its wall time inside `auth`/`db`.
 *
 * The migrations
 * `2026100322530000*_*.concurrent.ts` build the composites. This suite reads
 * the live catalog (`pg_index` + `pg_attribute`), never source text, so the
 * assertion cannot pass vacuously, and it checks COLUMN ORDER: a btree only
 * serves `account_id = $1 AND time >= $since` as a range scan when
 * `account_id` leads. On a database without the migrations every assertion
 * fails.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** account_id first, the reconciliation window's time column second. */
const EXPECTED_INDEXES: Array<{ table: string; index: string; columns: [string, string] }> = [
  {
    table: 'session_lifecycle_commands',
    index: 'idx_session_lifecycle_commands_account_created',
    columns: ['account_id', 'created_at'],
  },
  {
    table: 'session_lifecycle_commands',
    index: 'idx_session_lifecycle_commands_account_updated',
    columns: ['account_id', 'updated_at'],
  },
  {
    table: 'connector_calls',
    index: 'idx_connector_calls_account_created',
    columns: ['account_id', 'created_at'],
  },
  {
    table: 'connector_calls',
    index: 'idx_connector_calls_account_resolved',
    columns: ['account_id', 'resolved_at'],
  },
  {
    table: 'provider_events',
    index: 'idx_provider_events_account_created',
    columns: ['account_id', 'created_at'],
  },
  {
    table: 'tunnel_audit_logs',
    index: 'idx_tunnel_audit_account_created',
    columns: ['account_id', 'created_at'],
  },
  {
    table: 'project_sessions',
    index: 'idx_project_sessions_account_created',
    columns: ['account_id', 'created_at'],
  },
];

suite('audit reconciliation per-account windows are index-driven', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.end();
  });

  for (const expected of EXPECTED_INDEXES) {
    test(`${expected.table}: ${expected.index} covers (${expected.columns.join(', ')}) in order`, async () => {
      const { rows } = await client.query<{
        indisvalid: boolean;
        indisprimary: boolean;
        columns: string | null;
      }>(
        `select i.indisvalid,
                i.indisprimary,
                (select string_agg(a.attname, ',' order by k.ord)
                   from unnest(i.indkey) with ordinality as k(attnum, ord)
                   join pg_attribute a
                     on a.attrelid = i.indrelid and a.attnum = k.attnum
                ) as columns
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           join pg_index i on i.indexrelid = c.oid
          where c.relname = $1 and n.nspname = 'kortix'
            and c.relkind = 'i'`,
        [expected.index],
      );
      const [index] = rows;
      expect(index).toBeDefined();
      expect(index.indisvalid).toBe(true);
      expect(index.indisprimary).toBe(false);
      expect((index.columns ?? '').split(',')).toEqual(expected.columns);
    });
  }

  test('the bare (account_id) indexes this narrows are still present', async () => {
    // The composites ADD a path; they must not have replaced the original
    // single-column indexes other queries use.
    for (const [table, index] of [
      ['session_lifecycle_commands', 'idx_session_lifecycle_commands_account'],
      ['connector_calls', 'idx_connector_calls_account'],
      ['provider_events', 'idx_provider_events_account'],
      ['tunnel_audit_logs', 'idx_tunnel_audit_account'],
      ['project_sessions', 'idx_project_sessions_account'],
    ] as const) {
      const { rows } = await client.query(
        `select 1 from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where c.relname = $1 and n.nspname = 'kortix' and c.relkind = 'i'
            and exists (select 1 from pg_index i
                         where i.indexrelid = c.oid and i.indisvalid)`,
        [index],
      );
      expect(rows.length).toBe(1);
    }
  });
});
