import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

// The public.agent_runs legacy table is not a migration object: the Kortix
// baseline never creates it (it predates the baseline; only the on-demand
// legacy-transfer export tool reads it, whole-table, never by index). The
// drop_agent_runs_unused_indexes migration must therefore guard its ten
// DROP INDEX CONCURRENTLY statements with IF EXISTS:
//
//   - on every fresh database (self-host bootstrap, CI shadow, preview) the
//     table is absent, so the whole migration chain must still apply; and
//   - where the legacy table exists (prod), the ten indexes the Supabase
//     advisor flags as unused (KRTX-1219) must be gone, while the pkey and
//     every kept index survive.
//
// The advisor's unused_index finding on public.agent_runs is one finding per
// entity, so the migration drops all ten idx_scan = 0 indexes; a single
// survivor would keep the finding alive.
//
//   AGENT_RUNS_UNUSED_INDEXES_TEST_URL=postgresql://… bun test tests/migration/agent-runs-unused-indexes.test.ts
//   (without the URL the suite starts its own throwaway Docker Postgres;
//    with neither it skips — a Docker-less sandbox exports the URL instead)

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-agent-runs-unused-indexes-test';
// Host port for the throwaway container. MUST stay BELOW 32768: Linux's default
// ephemeral range is 32768-60999 (`/proc/sys/net/ipv4/ip_local_port_range`), and
// an outbound socket from the suite can transiently own a port in it — Docker
// then fails the run with `bind: address already in use`.
const EXTERNAL_URL = process.env.AGENT_RUNS_UNUSED_INDEXES_TEST_URL;
const PORT = Number(
  process.env.AGENT_RUNS_UNUSED_INDEXES_TEST_PORT ||
    EXTERNAL_URL?.match(/:([0-9]+)\//)?.[1] ||
    5449,
);
const ROOT = repoRoot();
// runMigrate derives its URL from ports.sbDb, so the port must follow the URL.
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const URL = EXTERNAL_URL || `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
// The ledger stores basename-minus-extension, so the .concurrent.ts file is
// `..._drop_agent_runs_unused_indexes.concurrent`.
const MIGRATION = '20261003060702025_drop_agent_runs_unused_indexes';

// The exact ten indexes the advisor flags on public.agent_runs and the
// migration drops. Mirrors the prod definitions read-only on 2026-10-03.
const UNUSED_INDEXES = [
  'create index idx_agent_runs_metadata on public.agent_runs using gin (metadata)',
  'create index idx_agent_runs_status_created_desc on public.agent_runs using btree (status, created_at desc)',
  'create index idx_agent_runs_thread_created_desc on public.agent_runs using btree (thread_id, created_at desc)',
  'create index idx_agent_runs_created_at_desc on public.agent_runs using btree (created_at desc)',
  'create index idx_agent_runs_started_at on public.agent_runs using btree (started_at desc)',
  'create index idx_agent_runs_thread_status on public.agent_runs using btree (thread_id, status)',
  `create index idx_agent_runs_thread_status_started on public.agent_runs using btree (thread_id, status, started_at desc) where (status = 'running'::text)`,
  `create index idx_agent_runs_status_running on public.agent_runs using btree (status, started_at desc) where (status = 'running'::text)`,
  'create index idx_agent_runs_status on public.agent_runs using btree (status)',
  `create index idx_agent_runs_status_thread on public.agent_runs using btree (status, thread_id) where (status = 'running'::text)`,
];

function psql(sql: string): string {
  const res = sh(['psql', URL, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

function pgReady(): boolean {
  return sh(['psql', URL, '-tAc', 'select 1']).ok;
}

const hasDatabase = Boolean(EXTERNAL_URL) || dockerOk;
const suite = hasDatabase ? describe : describe.skip;

suite('agent_runs unused indexes (throwaway Postgres)', () => {
  beforeAll(async () => {
    if (!EXTERNAL_URL) {
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
    }
    for (let i = 0; i < 30; i++) {
      if (pgReady()) return;
      await Bun.sleep(1000);
    }
    throw new Error('the provided test Postgres never became ready');
  }, 120_000);

  afterAll(() => {
    if (!EXTERNAL_URL) sh(['docker', 'rm', '-f', CONTAINER]);
  });

  test('applies green where the legacy table does not exist (fresh database)', async () => {
    const code = await runMigrate(ROOT, ports);
    expect(code).toBe(0);
    expect(psql("select to_regclass('public.agent_runs') is null")).toBe('t');
  }, 180_000);

  test('drops all ten unused indexes where the legacy table exists (prod shape)', async () => {
    // Mirror the prod legacy table (synthetic rows only): uuid pkey, the
    // columns the ten indexes reference, no FK to auth.users (none of the
    // dropped indexes or the pkey need one for the drop).
    psql(`create table public.agent_runs (
            id uuid primary key default gen_random_uuid(),
            user_id uuid,
            thread_id uuid,
            agent_version_id uuid,
            status text not null default 'queued',
            started_at timestamptz,
            created_at timestamptz not null default now(),
            metadata jsonb
          )`);
    for (const ddl of UNUSED_INDEXES) psql(ddl);
    psql(
      `insert into public.agent_runs (thread_id, status, started_at, created_at, metadata)
       select gen_random_uuid(), 'completed', now(), now(), '{}'
       from generate_series(1, 100)`,
    );
    expect(psql('select count(*) from public.agent_runs')).toBe('100');
    expect(
      psql(
        "select count(*) from pg_indexes where schemaname = 'public' and tablename = 'agent_runs'",
      ),
    ).toBe('11');
    // Re-run only the migration under test: drop its ledger row, then migrate.
    psql(`delete from kortix_migrations.pgmigrations where name like '${MIGRATION}%'`);
    const code = await runMigrate(ROOT, ports);
    expect(code).toBe(0);
    const remaining = psql(
      "select indexname from pg_indexes where schemaname = 'public' and tablename = 'agent_runs' order by indexname",
    );
    expect(remaining).toBe('agent_runs_pkey');
    // The table and its rows survive the drop.
    expect(psql('select count(*) from public.agent_runs')).toBe('100');
    // The migration is idempotent through IF EXISTS: re-run it again through
    // the no-index branch (drop the ledger row so the runner actually applies it).
    psql(`delete from kortix_migrations.pgmigrations where name like '${MIGRATION}%'`);
    const again = await runMigrate(ROOT, ports);
    expect(again).toBe(0);
    expect(
      psql(
        "select count(*) from pg_indexes where schemaname = 'public' and tablename = 'agent_runs'",
      ),
    ).toBe('1');
  }, 180_000);
});

if (!hasDatabase) {
  // biome-ignore lint/suspicious/noSkippedTests: This integration suite requires a running Postgres (Docker container or AGENT_RUNS_UNUSED_INDEXES_TEST_URL).
  test.skip('agent_runs unused indexes integration (no Postgres available — skipped)', () => {});
}
