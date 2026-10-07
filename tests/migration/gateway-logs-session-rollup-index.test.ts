// KRTX-1311: the per-session gateway rollup — listProjectGatewaySessionSpend
// (apps/api/src/shared/session-costs.ts), GET /v1/projects/{projectId}/gateway/
// sessions — aggregated one project's gateway logs per session_id over a day
// window at a prod mean of 1150.9 ms (pg_stat_statements, 150 calls, buffer
// hit rate 81%). Its prod plan was a BitmapAnd of two index bitmaps feeding a
// Bitmap Heap Scan (~346k rows, ~358 MB heap touched) and an external-merge
// sort spilling ~36 MB to temp just to order rows by session_id for the
// GroupAggregate.
//
// 20261005194500009_gateway_logs_session_rollup_index.concurrent.ts builds the
// covering index that serves the whole aggregate from the index alone:
// (project_id, session_id, created_at) INCLUDE (account_id, ok,
// final_cost_precise, upstream_cost_precise, billing_mode, input_tokens,
// output_tokens, requested_model) WHERE session_id IS NOT NULL. The key order
// gives GROUP BY session_id order for a fixed project (no sort), and INCLUDE
// carries every referenced column (no heap fetch).
//
// What this test proves deterministically, on one throwaway Postgres seeded
// with the shape that exercises every index column (null and non-null
// session_id, every billing_mode, ok and not-ok rows, several models):
//
//   presence — the migration builds a VALID index with the INCLUDE columns
//              (which the drizzle declaration cannot express) and the partial
//              predicate, and records itself in the ledger;
//   behavior — the statement's result is byte-identical with and without the
//              index (drop / compare / recreate), so the index changes no row.
//
// The plan flip itself (Index Only Scan replacing the bitmap heap scan and the
// disk-spill sort) is scale-dependent planner behavior, so it is not asserted
// at test scale; it is shown by the prod EXPLAIN and the prod-shaped sandbox
// EXPLAIN in the KRTX-1311 PR description.
//
//   bun test tests/migration/gateway-logs-session-rollup-index.test.ts   (needs docker)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-gateway-logs-rollup-index-test';
// Below 32768 for the reason given in worktree-migrate.test.ts.
const PORT = Number(process.env.GATEWAY_LOGS_ROLLUP_INDEX_TEST_PORT || 5449);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const MIGRATION_NAME = '20261005194500009_gateway_logs_session_rollup_index.concurrent';
const INDEX = 'idx_gateway_logs_project_session_time';

// The statement under test: the exact rendered shape of
// listProjectGatewaySessionSpend (Drizzle renders it exactly like this), with
// synthetic constants.
const STATEMENT = `
  select "session_id", count(*)::int,
         count(*) filter (where not "ok")::int,
         coalesce(sum(("kortix"."gateway_request_logs"."final_cost_precise" + (
           case when coalesce(
             "kortix"."gateway_request_logs"."billing_mode",
             case when "kortix"."gateway_request_logs"."final_cost_precise" > 0 then 'credits' else 'none' end
           ) = 'credits' then 0 else "kortix"."gateway_request_logs"."upstream_cost_precise" end
         ))), 0)::float8,
         coalesce(sum("input_tokens" + "output_tokens"), 0)::float8,
         count(distinct "requested_model")::int,
         max("created_at")
    from "kortix"."gateway_request_logs"
   where ("kortix"."gateway_request_logs"."account_id" = '11111111-1111-4111-8111-111111111111'
     and "kortix"."gateway_request_logs"."project_id" = '22222222-2222-4222-8222-222222222201'
     and "kortix"."gateway_request_logs"."session_id" is not null
     and "kortix"."gateway_request_logs"."created_at" >= now() - make_interval(days => 30))
   group by "kortix"."gateway_request_logs"."session_id"
`;

// Order-independent digest of the statement's result, so the with/without
// comparison does not depend on row order (the planner is free to reorder).
const RESULT_DIGEST = `
  select md5(coalesce(string_agg(md5(row_to_json(r)::text), '' order by session_id), ''))
    from (${STATEMENT.replace(/;/g, '')}) r
`;

// Synthetic data that exercises every column the index carries: one busy
// project with 76% of its rows inside the last 30 days, ~5k sessions, 2% null
// session_id, every billing_mode, and error rows; plus small neighbor and
// filler projects on other shapes of the same predicate space.
const SEED_SQL = `
  insert into kortix.accounts (account_id, name)
  values ('11111111-1111-4111-8111-111111111111', 'seed account'),
         ('33333333-3333-4333-8333-333333333301', 'filler a'),
         ('33333333-3333-4333-8333-333333333302', 'filler b')
  on conflict do nothing;
  insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status, created_at)
  values ('22222222-2222-4222-8222-222222222201', '11111111-1111-4111-8111-111111111111', 'seed busy', 'https://example.test/seed/busy', 'main', 'kortix.yaml', 'active', now() - interval '200 days'),
         ('22222222-2222-4222-8222-222222222202', '11111111-1111-4111-8111-111111111111', 'seed side a', 'https://example.test/seed/a', 'main', 'kortix.yaml', 'active', now() - interval '200 days'),
         ('22222222-2222-4222-8222-222222222203', '11111111-1111-4111-8111-111111111111', 'seed side b', 'https://example.test/seed/b', 'main', 'kortix.yaml', 'active', now() - interval '200 days'),
         ('22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333301', 'filler a1', 'https://example.test/seed/fa', 'main', 'kortix.yaml', 'active', now() - interval '200 days'),
         ('22222222-2222-4222-8222-222222222221', '33333333-3333-4333-8333-333333333302', 'filler b1', 'https://example.test/seed/fb', 'main', 'kortix.yaml', 'active', now() - interval '200 days')
  on conflict do nothing;
  insert into kortix.gateway_request_logs
    (request_id, account_id, project_id, session_id, requested_model, resolved_model,
     provider, status, ok, latency_ms, input_tokens, output_tokens,
     upstream_cost_precise, final_cost_precise, billing_mode, request, response, created_at)
  select 'req-' || md5(s.tag || g::text), s.account_id::uuid, s.project_id::uuid,
         case when g % 50 = 0 then null else 's-' || md5((s.tag || (g % 5000)::text)) end,
         (array['gpt-x','claude-y'])[1 + g % 2], (array['gpt-x','claude-y'])[1 + g % 2],
         (array['openai','anthropic'])[1 + g % 2],
         200, (g % 20) <> 0, 100 + (g % 40000),
         500 + (g % 4000), 100 + (g % 2000),
         ((g % 1301))::numeric / 10000,
         case when g % 13 = 0 then 0 else ((g % 977))::numeric / 10000 end,
         case g % 50 when 0 then null when 1 then 'none' else 'credits' end,
         jsonb_build_object('messages', repeat('p', 300)),
         jsonb_build_object('text', repeat('r', 300)),
         now() - make_interval(days => (case
           when s.tag in ('sidea', 'sideb') then (g::numeric % 2900) / 100
           when g % 100 < 76 then ((g::numeric % 3000) / 100)::int
           else 30 + ((g::numeric % 9000) / 100)::int end)::int)
  from (values
    ('busy', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 50000),
    ('sidea', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222202', 5000),
    ('sideb', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222203', 5000),
    ('fillera', '33333333-3333-4333-8333-333333333301', '22222222-2222-4222-8222-222222222211', 10000),
    ('fillerb', '33333333-3333-4333-8333-333333333302', '22222222-2222-4222-8222-222222222221', 10000)
  ) as s(tag, account_id, project_id, n), generate_series(1, 50000) g
  where g <= s.n;
`;

// Separate call: VACUUM cannot run inside the implicit transaction a
// multi-statement psql -c string opens (the same rule that forces the
// .concurrent.ts escape hatch for CREATE INDEX CONCURRENTLY).
const ANALYZE_SQL = 'vacuum (analyze) kortix.gateway_request_logs;';

function psqlOn(url: string, query: string): string {
  const res = sh(['psql', url, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', query]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${query}`);
  return res.stdout.trim();
}

const psql = (query: string): string => psqlOn(URL, query);

function pgReady(): boolean {
  return sh(['psql', URL, '-tAc', 'select 1']).ok;
}

function indexValid(): string {
  return psql(`
    select i.indisvalid
      from pg_class c
      join pg_index i on i.indexrelid = c.oid
     where c.relname = '${INDEX}'
  `);
}

/** The built definition must carry the INCLUDE columns the declaration cannot express. */
function includeColumns(): string[] {
  const def = psql(`select indexdef from pg_indexes where indexname = '${INDEX}'`);
  const match = /include \(([^)]+)\)/i.exec(def);
  if (!match) return [];
  return match[1].split(',').map((column) => column.trim());
}

const suite = dockerOk ? describe : describe.skip;

suite('gateway_request_logs per-session rollup covering index (throwaway Postgres)', () => {
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
      if (pgReady()) break;
      await Bun.sleep(1000);
    }
    if (!pgReady()) throw new Error('test Postgres never became ready');

    const code = await runMigrate(ROOT, ports);
    if (code !== 0) throw new Error('migrations failed');
  }, 480_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', CONTAINER]);
  });

  test('the migration builds a VALID covering index with the INCLUDE columns and the partial predicate', () => {
    expect(indexValid()).toBe('t');
    expect(includeColumns()).toEqual(
      expect.arrayContaining([
        'account_id',
        'ok',
        'final_cost_precise',
        'upstream_cost_precise',
        'billing_mode',
        'input_tokens',
        'output_tokens',
        'requested_model',
      ]),
    );
    expect(
      psql(
        `select indpred is not null from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = '${INDEX}'`,
      ),
    ).toBe('t');
  });

  test('the migration records itself in the ledger', () => {
    expect(
      psql(`select count(*) from kortix_migrations.pgmigrations where name = '${MIGRATION_NAME}'`),
    ).toBe('1');
  });

  test('the rollup statement returns byte-identical rows with and without the index', () => {
    psql(SEED_SQL);
    psql(ANALYZE_SQL);
    const withIndex = psql(RESULT_DIGEST);
    expect(withIndex).not.toBe('');
    psql(`drop index kortix.${INDEX}`);
    const withoutIndex = psql(RESULT_DIGEST);
    expect(withoutIndex).toBe(withIndex);
    // Recreate through the migration's own statement, so the test also proves
    // the CONCURRENTLY build re-runs cleanly on a seeded table. The SET and the
    // CREATE go in separate psql calls: one string is an implicit transaction
    // block, and CONCURRENTLY cannot run inside one.
    psql(`set lock_timeout = '60s'`);
    psql(
      `\n      create index concurrently if not exists ${INDEX}\n        on kortix.gateway_request_logs (project_id, session_id, created_at)\n        include (account_id, ok, final_cost_precise, upstream_cost_precise,\n                 billing_mode, input_tokens, output_tokens, requested_model)\n        where session_id is not null\n    `,
    );
    expect(indexValid()).toBe('t');
  }, 300_000);
});
