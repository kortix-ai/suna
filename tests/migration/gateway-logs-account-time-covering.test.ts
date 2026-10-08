// KRTX-1769: regression test for the account+time cost covering index built by
// 20261007235952000_gateway_logs_account_time_covering.concurrent.ts (the
// account+window aggregates: getCostSummary and getCostByProject in
// apps/api/src/shared/cost-rollups.ts, served by GET /v1/usage/cost-summary
// and GET /v1/usage/cost-by-project, plus the llmAggregateSubquery in
// apps/api/src/shared/session-costs.ts). The measured evidence and the plan
// shapes live in that migration's header and the KRTX-1769 PR description;
// the plan flip (Index Only Scan) is scale-dependent planner behavior, so it
// is not asserted at test scale.
//
// What this test proves deterministically, on one throwaway Postgres:
//
//   presence — the migration builds a VALID index whose key columns and
//              INCLUDE columns (which the drizzle declaration cannot express)
//              match the aggregates' needs, and records itself in the ledger;
//   behavior — the CONCURRENTLY build re-runs cleanly on a seeded table (the
//              beforeAll build runs on an empty one).
//
//   bun test tests/migration/gateway-logs-account-time-covering.test.ts   (needs docker)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-gateway-logs-account-covering-index-test';
// Below 32768 for the reason given in worktree-migrate.test.ts.
const PORT = Number(process.env.GATEWAY_LOGS_ACCOUNT_COVERING_INDEX_TEST_PORT || 5452);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const MIGRATION_NAME = '20261007235952000_gateway_logs_account_time_covering.concurrent';
const INDEX = 'idx_gateway_logs_account_time_covering';

// Synthetic rows: one per shape the index carries — null session_id, a
// billing_mode the coalesce treats as non-Kortix-billed, an ok=false row —
// so the concurrent rebuild runs over a table with NULLs and varied rows,
// not a trivial one-row table.
const SEED_SQL = `
  insert into kortix.accounts (account_id, name)
  values ('11111111-1111-4111-8111-111111111111', 'seed account')
  on conflict do nothing;
  insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status, created_at)
  values ('22222222-2222-4222-8222-222222222201', '11111111-1111-4111-8111-111111111111', 'seed project', 'https://example.test/seed/main', 'main', 'kortix.yaml', 'active', now() - interval '200 days')
  on conflict do nothing;
  insert into kortix.gateway_request_logs
    (request_id, account_id, project_id, session_id, requested_model, resolved_model,
     provider, status, ok, latency_ms, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
     upstream_cost_precise, final_cost_precise, billing_mode, request, response, created_at)
  values
    ('req-seed-01', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 's-seed-0', 'gpt-x', 'gpt-x', 'openai', 200, true,  120, 500, 100, 10, 5,  0.0123, 0.0456, 'credits', jsonb_build_object('messages', 'p'), jsonb_build_object('text', 'r'), now() - interval '1 day'),
    ('req-seed-02', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', null,       'gpt-x', 'gpt-x', 'openai', 200, false, 130, 600, 110, 0,  0,  0.0234, 0.0000, 'credits', jsonb_build_object('messages', 'p'), jsonb_build_object('text', 'r'), now() - interval '2 days'),
    ('req-seed-03', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201', 's-seed-1', 'claude-y', 'claude-y', 'anthropic', 200, true,  140, 700, 120, 20, 6,  0.0345, 0.0567, 'none',    jsonb_build_object('messages', 'p'), jsonb_build_object('text', 'r'), now() - interval '3 days');
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

suite('gateway_request_logs account+time cost covering index (throwaway Postgres)', () => {
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

  test('the migration builds a VALID covering index with the exact key order and INCLUDE columns', () => {
    expect(indexValid()).toBe('t');
    // (account_id, created_at) is the key every account+window aggregate
    // filters on, so assert it as rendered, not just as a column set.
    expect(indexDef()).toContain('(account_id, created_at)');
    expect(includeColumns()).toEqual(
      expect.arrayContaining([
        'session_id',
        'project_id',
        'provider',
        'resolved_model',
        'billing_mode',
        'ok',
        'final_cost_precise',
        'upstream_cost_precise',
        'input_tokens',
        'output_tokens',
        'cached_tokens',
        'cache_write_tokens',
      ]),
    );
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
         on kortix.gateway_request_logs (account_id, created_at) include (
           session_id, project_id, provider, resolved_model, billing_mode, ok,
           final_cost_precise, upstream_cost_precise, input_tokens,
           output_tokens, cached_tokens, cache_write_tokens
         )`,
    );
    expect(indexValid()).toBe('t');
  }, 120_000);
});
