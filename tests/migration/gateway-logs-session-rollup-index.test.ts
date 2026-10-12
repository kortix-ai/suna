// KRTX-1311: regression test for the per-session gateway rollup covering
// index built by 20261007050000009_gateway_logs_session_rollup_index.concurrent.ts
// (listProjectGatewaySessionSpend, apps/api/src/shared/session-costs.ts, served
// by GET /v1/projects/{projectId}/gateway/sessions). The measured evidence and
// the plan shapes live in that migration's header and the KRTX-1311 PR
// description; the plan flip (Index Only Scan) is scale-dependent planner
// behavior, so it is not asserted at test scale.
//
// What this test proves deterministically, on one throwaway Postgres:
//
//   presence — the migration builds a VALID index whose key columns, INCLUDE
//              columns (which the drizzle declaration cannot express) and
//              partial predicate match the statement's needs, and records
//              itself in the ledger;
//   behavior — the CONCURRENTLY build re-runs cleanly on a seeded table (the
//              beforeAll build runs on an empty one).
//
//   bun test tests/migration/gateway-logs-session-rollup-index.test.ts   (needs docker)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-gateway-logs-rollup-index-test';
// Below 32768 for the reason given in worktree-migrate.test.ts.
const PORT = Number(process.env.GATEWAY_LOGS_ROLLUP_INDEX_TEST_PORT || 5451);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const MIGRATION_NAME = '20261007050000009_gateway_logs_session_rollup_index.concurrent';
const INDEX = 'idx_gateway_logs_project_session_time';

// Synthetic rows that exercise every column the index carries: null and
// non-null session_id, every billing_mode (including the coalesced-null
// 'credits' path), ok and not-ok rows, zero and non-zero final_cost_precise,
// two models, rows inside and outside the 30-day window, plus a neighbor
// project so the project_id key actually filters.
const SEED_SQL = `
  insert into kortix.accounts (account_id, name)
  values ('11111111-1111-4111-8111-111111111111', 'seed account'),
         ('33333333-3333-4333-8333-333333333301', 'filler a')
  on conflict do nothing;
  insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status, created_at)
  values ('22222222-2222-4222-8222-222222222201', '11111111-1111-4111-8111-111111111111', 'seed project', 'https://example.test/seed/main', 'main', 'kortix.yaml', 'active', now() - interval '200 days'),
         ('22222222-2222-4222-8222-222222222211', '33333333-3333-4333-8333-333333333301', 'filler project', 'https://example.test/seed/filler', 'main', 'kortix.yaml', 'active', now() - interval '200 days')
  on conflict do nothing;
  insert into kortix.gateway_request_logs
    (request_id, account_id, project_id, session_id, requested_model, resolved_model,
     provider, status, ok, latency_ms, input_tokens, output_tokens,
     upstream_cost_precise, final_cost_precise, billing_mode, request, response, created_at)
  values
    ('req-seed-01', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 's-seed-0', 'gpt-x', 'gpt-x', 'openai', 200, true,  120, 500, 100, 0.0123, 0.0456, 'credits', jsonb_build_object('messages', 'p'), jsonb_build_object('text', 'r'), now() - interval '1 day'),
    ('req-seed-02', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 's-seed-0', 'gpt-x', 'gpt-x', 'openai', 200, false, 130, 600, 110, 0.0234, 0.0000, 'credits', jsonb_build_object('messages', 'p'), jsonb_build_object('text', 'r'), now() - interval '2 days'),
    ('req-seed-03', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 's-seed-1', 'claude-y', 'claude-y', 'anthropic', 200, true,  140, 700, 120, 0.0345, 0.0567, 'none',    jsonb_build_object('messages', 'p'), jsonb_build_object('text', 'r'), now() - interval '3 days'),
    ('req-seed-04', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 's-seed-1', 'claude-y', 'claude-y', 'anthropic', 200, true,  150, 800, 130, 0.0456, 0.0678, null,      jsonb_build_object('messages', 'p'), jsonb_build_object('text', 'r'), now() - interval '10 days'),
    ('req-seed-05', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 's-seed-1', 'gpt-x', 'gpt-x', 'openai', 200, false, 160, 900, 140, 0.0567, 0.0000, null,      jsonb_build_object('messages', 'p'), jsonb_build_object('text', 'r'), now() - interval '20 days'),
    ('req-seed-06', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', null,       'gpt-x', 'gpt-x', 'openai', 200, true,  170, 1000, 150, 0.0678, 0.0789, 'credits', jsonb_build_object('messages', 'p'), jsonb_build_object('text', 'r'), now() - interval '5 days'),
    ('req-seed-07', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 's-seed-0', 'gpt-x', 'gpt-x', 'openai', 200, true,  180, 1100, 160, 0.0789, 0.0890, 'credits', jsonb_build_object('messages', 'p'), jsonb_build_object('text', 'r'), now() - interval '40 days'),
    ('req-seed-08', '33333333-3333-4333-8333-333333333301', '22222222-2222-4222-8222-222222222211', 's-filler', 'gpt-x', 'gpt-x', 'openai', 200, true,  190, 1200, 170, 0.0890, 0.0901, 'credits', jsonb_build_object('messages', 'p'), jsonb_build_object('text', 'r'), now() - interval '1 day');
`;

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

function indexDef(): string {
  return psql(`select indexdef from pg_indexes where indexname = '${INDEX}'`);
}

/** The built definition must carry the INCLUDE columns the declaration cannot express. */
function includeColumns(): string[] {
  const match = /include \(([^)]+)\)/i.exec(indexDef());
  if (!match) return [];
  return match[1].split(',').map((column) => column.trim());
}

const suite = dockerOk ? describe : describe.skip;

suite('gateway_request_logs per-session rollup covering index (throwaway Postgres)', () => {
  beforeAll(async () => {
    sh(['docker', 'rm', '-f', '-v', CONTAINER]);
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
    sh(['docker', 'rm', '-f', '-v', CONTAINER]);
  });

  test('the migration builds a VALID covering index with the exact key order, INCLUDE columns and partial predicate', () => {
    expect(indexValid()).toBe('t');
    // The key order is what serves GROUP BY session_id for a fixed project
    // without a sort, so assert it as rendered, not just as a column set.
    expect(indexDef()).toContain('(project_id, session_id, created_at)');
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

  test('the CONCURRENTLY build re-runs cleanly on a seeded table', () => {
    psql(SEED_SQL);
    // Drop first, so the re-create below is a real concurrent build over the
    // seeded rows, not the IF NOT EXISTS no-op over the migration's index.
    psql(`drop index if exists kortix.${INDEX}`);
    // The SET and the CREATE go in separate psql calls: one string is an
    // implicit transaction block, and CONCURRENTLY cannot run inside one.
    psql(`set lock_timeout = '60s'`);
    psql(
      `create index concurrently if not exists ${INDEX}
         on kortix.gateway_request_logs (project_id, session_id, created_at)
         include (account_id, ok, final_cost_precise, upstream_cost_precise,
                  billing_mode, input_tokens, output_tokens, requested_model)
         where session_id is not null`,
    );
    expect(indexValid()).toBe('t');
  }, 120_000);
});
