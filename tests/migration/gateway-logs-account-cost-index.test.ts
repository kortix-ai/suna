import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

// KRTX-211 (Better Stack pattern 97669531): the cost-explorer and session-cost
// rollups (apps/api/src/shared/cost-rollups.ts, apps/api/src/shared/
// session-costs.ts) read (account_id, created_at) windows over
// kortix.gateway_request_logs and sum money/model columns on every row. The
// bare idx_gateway_logs_account_time made each sum a heap fetch per row; an
// active account's 30-day slice (~10^6 rows) blew the 25 s request-path
// statement_timeout (57014 -> 503).
//
// 20261005230000000_gateway_logs_account_cost_index.concurrent.ts builds the
// covering replacement (same keys, INCLUDE for exactly the read columns) and
// 20261005230000100_gateway_logs_account_time_index_drop.concurrent.ts drops
// the bare one — the drop is load-bearing: with BOTH indexes present the
// planner kept picking the narrower one. This suite proves, on a real
// Postgres:
//
//   1. a fresh database applies the whole chain green and ends with the
//      covering index valid and the bare one absent;
//   2. a prod-shaped database (bare index present, table populated)
//      upgrades in place — the drop is safe on an existing index;
//   3. the rollup statement plans as an INDEX-ONLY scan over the covering
//      index — every column the rollup reads lives inside the index.
//
//   bun test tests/migration/gateway-logs-account-cost-index.test.ts   (needs docker)

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-gateway-logs-cost-index-test';
// Host port for the throwaway container. MUST stay BELOW 32768: Linux's default
// ephemeral range is 32768-60999 (`/proc/sys/net/ipv4/ip_local_port_range`), and
// an outbound socket from the suite can transiently own a port in it — Docker
// then fails the run with `bind: address already in use`.
const PORT = Number(process.env.GATEWAY_LOGS_COST_INDEX_TEST_PORT || 5450);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const CREATE_MIGRATION = '20261005230000000_gateway_logs_account_cost_index';
const DROP_MIGRATION = '20261005230000100_gateway_logs_account_time_index_drop';
// 200 synthetic accounts so the probed account's slice is ~0.5% of the table
// and the planner organically picks the index (no enable_* forcing).
const ACCOUNTS = 200;
const ROWS = 200_000;

function psql(sql: string): string {
  const res = sh(['psql', URL, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

function pgReady(): boolean {
  return sh(['psql', URL, '-tAc', 'select 1']).ok;
}

function indexDefinition(name: string): string {
  return psql(`select coalesce(indexdef, '') from pg_indexes where indexname = '${name}'`);
}

function isValidIndex(name: string): string {
  return psql(
    `select coalesce(bool_and(i.indisvalid), false)
       from pg_class c join pg_index i on i.indexrelid = c.oid
      where c.relname = '${name}'`,
  );
}

// Mirrors the LLM aggregate of listCostByProject (apps/api/src/shared/
// cost-rollups.ts): same predicate shape (account_id + created_at window +
// project_id is not null), same reads (project_id, session_id, billing_mode,
// final/upstream cost, created_at). Every referenced column must live inside
// idx_gateway_logs_account_cost's INCLUDE list for the index-only plan.
const ROLLUP_SQL = `select project_id,
       coalesce(sum(final_cost_precise), 0)::float8,
       coalesce(sum(case when billing_mode = 'credits' then final_cost_precise else 0 end), 0)::float8,
       coalesce(sum(upstream_cost_precise), 0)::float8,
       count(distinct session_id)::int,
       max(created_at)
  from kortix.gateway_request_logs
 where account_id = '00000000-0000-4000-a000-000000000010'::uuid
   and created_at >= now() - interval '30 days'
   and created_at < now()
   and project_id is not null
 group by project_id`;

const suite = dockerOk ? describe : describe.skip;

suite('gateway_request_logs account cost covering index (throwaway Postgres)', () => {
  beforeAll(async () => {
    sh(['docker', 'rm', '-f', CONTAINER]);
    const up = sh([
      'docker',
      'run',
      '-d',
      '--name',
      CONTAINER,
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-e',
      'POSTGRES_USER=postgres',
      '-e',
      'POSTGRES_DB=postgres',
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-p',
      `127.0.0.1:${PORT}:5432`,
      'postgres:16-alpine',
      '-c',
      'fsync=off',
      '-c',
      'synchronous_commit=off',
      '-c',
      'full_page_writes=off',
    ]);
    if (!up.ok) throw new Error(`could not start test container: ${up.stderr}`);
    for (let i = 0; i < 60; i++) {
      if (pgReady()) return;
      await Bun.sleep(1000);
    }
    throw new Error('test Postgres never became ready');
  }, 120_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', CONTAINER]);
  });

  test('applies green on a fresh database: covering index valid, bare index gone', async () => {
    const code = await runMigrate(ROOT, ports);
    expect(code).toBe(0);
    expect(indexDefinition('idx_gateway_logs_account_cost')).toContain(
      'idx_gateway_logs_account_cost ON kortix.gateway_request_logs USING btree (account_id, created_at) INCLUDE',
    );
    expect(isValidIndex('idx_gateway_logs_account_cost')).toBe('t');
    expect(indexDefinition('idx_gateway_logs_account_time')).toBe('');
  }, 240_000);

  test('upgrades a prod-shaped database in place (bare index present, table populated)', async () => {
    // Rebuild the pre-migration shape: parent rows, a populated table, the
    // bare account index, and no covering index.
    psql(`
      insert into kortix.accounts (account_id, name)
        values ('00000000-0000-4000-a000-000000000001'::uuid, 'Rollup Account'),
               ('00000000-0000-4000-a000-000000000002'::uuid, 'Other Account')
      on conflict do nothing
    `);
    psql(`
      insert into kortix.projects (project_id, account_id, name, repo_url)
        values ('00000000-0000-4000-a000-00000000a001'::uuid,
                '00000000-0000-4000-a000-000000000001'::uuid, 'Rollup Project', 'https://example.test/r.git')
      on conflict do nothing
    `);
    psql('delete from kortix.gateway_request_logs');
    psql(
      `create index if not exists idx_gateway_logs_account_time
         on kortix.gateway_request_logs (account_id, created_at)`,
    );
    psql('drop index if exists kortix.idx_gateway_logs_account_cost');
    psql(`
      insert into kortix.gateway_request_logs
        (request_id, account_id, project_id, session_id, provider, requested_model,
         resolved_model, billing_mode, status, ok, created_at,
         upstream_cost_precise, final_cost_precise)
      select gen_random_uuid()::text,
             '00000000-0000-4000-a000-000000000001'::uuid,
             '00000000-0000-4000-a000-00000000a001'::uuid,
             'sess-krtx211-0001',
             'test-provider',
             'test-provider',
             'test-model',
             'credits',
             200,
             true,
             now() - (n || ' minutes')::interval,
             0.5,
             1.0
        from generate_series(1, 5000) n
    `);
    expect(psql('select count(*) from kortix.gateway_request_logs')).toBe('5000');

    // Re-run only the two migrations under test (drop their ledger rows, migrate).
    psql(`delete from kortix_migrations.pgmigrations where name like '${CREATE_MIGRATION}%'`);
    psql(`delete from kortix_migrations.pgmigrations where name like '${DROP_MIGRATION}%'`);
    const code = await runMigrate(ROOT, ports);
    expect(code).toBe(0);

    expect(indexDefinition('idx_gateway_logs_account_cost')).toContain(
      'idx_gateway_logs_account_cost ON kortix.gateway_request_logs USING btree (account_id, created_at) INCLUDE',
    );
    expect(isValidIndex('idx_gateway_logs_account_cost')).toBe('t');
    expect(indexDefinition('idx_gateway_logs_account_time')).toBe('');

    // Re-running the pair is safe (IF [NOT] EXISTS): another ledger drop + run
    // changes nothing.
    psql(`delete from kortix_migrations.pgmigrations where name like '${CREATE_MIGRATION}%'`);
    psql(`delete from kortix_migrations.pgmigrations where name like '${DROP_MIGRATION}%'`);
    expect(await runMigrate(ROOT, ports)).toBe(0);
    expect(isValidIndex('idx_gateway_logs_account_cost')).toBe('t');
  }, 360_000);

  test('the cost rollup plans as an index-only scan over the covering index', async () => {
    // A spread wide enough that the probed account's 30-day slice is ~0.5% of
    // the table. VACUUM FREEZE marks the seeded pages all-visible — without
    // an all-visible map the planner costs index-only scans as heap-fetching
    // (on this fixture plain `vacuum analyze` leaves relallvisible at 0, so
    // the test would flap), and then the test would assert the planner's
    // pessimism, not the index. With bitmap and sequential scans off the
    // remaining choice isolates the claim under test: when the planner
    // reaches for an index, the covering index answers the WHOLE rollup —
    // keys plus every summed/grouped column — without touching the heap.
    // Whether prod's planner picks it at multi-GB scale is the post-merge
    // signal check's question, not this fixture's.
    // A spread wide enough that the probed account's 30-day slice is ~0.5% of
    // the table, so the planner picks the index with default settings — the
    // question the prod planner faces on a multi-GB heap.
    psql(`
      insert into kortix.accounts (account_id, name)
      select ('00000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid, 'Spread Account ' || n
        from generate_series(10, ${ACCOUNTS + 9}) n
      on conflict do nothing
    `);
    psql(`
      insert into kortix.projects (project_id, account_id, name, repo_url)
      select ('00000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid,
             ('00000000-0000-4000-a000-' || lpad(n::text, 12, '0'))::uuid,
             'Spread Project ' || n, 'https://example.test/r.git'
        from generate_series(10, ${ACCOUNTS + 9}) n
      on conflict do nothing
    `);
    psql(`
      insert into kortix.gateway_request_logs
        (request_id, account_id, project_id, session_id, provider, requested_model,
         resolved_model, billing_mode, status, ok, created_at,
         upstream_cost_precise, final_cost_precise)
      select gen_random_uuid()::text,
             ('00000000-0000-4000-a000-' || lpad(((n % ${ACCOUNTS}) + 10)::text, 12, '0'))::uuid,
             ('00000000-0000-4000-a000-' || lpad(((n % ${ACCOUNTS}) + 10)::text, 12, '0'))::uuid,
             null,
             'test-provider',
             'test-provider',
             'test-model',
             'credits',
             200,
             true,
             now() - ((n % 43200) || ' minutes')::interval,
             0.5,
             1.0
        from generate_series(1, ${ROWS}) n
    `);
    psql('vacuum (freeze, analyze) kortix.gateway_request_logs');

    const raw = psql(
      `set enable_seqscan = off; set enable_bitmapscan = off; explain (format json) ${ROLLUP_SQL}`,
    );
    const planJson = raw.slice(raw.indexOf('['));
    const nodes: any[] = [];
    const walk = (node: any) => {
      if (!node || typeof node !== 'object') return;
      nodes.push(node);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(JSON.parse(planJson)[0]['Plan']);
    const indexOnly = nodes.find((n) => n['Node Type'] === 'Index Only Scan');
    expect(indexOnly).toBeDefined();
    expect(indexOnly?.['Index Name']).toBe('idx_gateway_logs_account_cost');
  }, 300_000);
});
