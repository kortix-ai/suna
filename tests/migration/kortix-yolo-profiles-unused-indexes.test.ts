import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

// The LLM gateway's `kortix_yolo` schema is not a migration object: the
// migrations neither create nor manage it (the Kortix baseline never creates
// the schema; it exists only on databases that carry the gateway, prod today).
// The drop_yolo_profiles_email_index migration must therefore rely on
// `IF EXISTS`:
//
//   - on every fresh database (self-host bootstrap, CI shadow, preview) the
//     schema is absent, so the whole migration chain must still apply
//     (Postgres skips a drop whose schema is absent with a NOTICE); and
//   - where the gateway schema exists (prod), the unused index the advisor
//     flags (profiles_email_idx) must be gone — while the pkey and
//     profiles_role_idx (no longer flagged: it registered a read) survive —
//     or the finding stays and every gateway write maintains a dead index.
//
//   bun test tests/migration/kortix-yolo-profiles-unused-indexes.test.ts   (needs docker)

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-yolo-profiles-index-test';
// Host port for the throwaway container. MUST stay BELOW 32768: Linux's default
// ephemeral range is 32768-60999 (`/proc/sys/net/ipv4/ip_local_port_range`), and
// an outbound socket from the suite can transiently own a port in it — Docker
// then fails the run with `bind: address already in use`.
const PORT = Number(process.env.YOLO_PROFILES_INDEX_TEST_PORT || 5449);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
// The ledger stores basename-minus-extension, so the .concurrent.ts file is
// `..._drop_yolo_profiles_email_index.concurrent`.
const MIGRATION = '20261004175018263_drop_yolo_profiles_email_index';

function psql(sql: string): string {
  const res = sh(['psql', URL, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

function pgReady(): boolean {
  return sh(['psql', URL, '-tAc', 'select 1']).ok;
}

const suite = dockerOk ? describe : describe.skip;

suite('kortix_yolo.profiles unused index (throwaway Postgres)', () => {
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

  test('applies green where the gateway schema does not exist (fresh database)', async () => {
    const code = await runMigrate(ROOT, ports);
    expect(code).toBe(0);
    expect(psql("select to_regclass('kortix_yolo.profiles') is null")).toBe('t');
    expect(psql("select to_regclass('kortix_yolo.profiles_email_idx') is null")).toBe('t');
  }, 180_000);

  test('drops the unused index where the gateway schema exists (prod shape)', async () => {
    // Mirror the prod gateway table (synthetic rows only): the pkey, the unused
    // index the advisor flags, and profiles_role_idx — which the advisor no
    // longer flags and this migration must leave in place.
    psql('create schema kortix_yolo');
    psql(`create table kortix_yolo.profiles (
            id uuid primary key,
            email text,
            display_name text,
            role text,
            enabled boolean not null default true,
            created_at timestamp not null default now(),
            updated_at timestamp not null default now(),
            tier text,
            custom_quota_limit integer,
            custom_window_ms bigint,
            custom_auth_error_message text,
            sync_generation text,
            stripe_customer_id text,
            stripe_subscription_id text,
            subscription_status text,
            subscription_period_end timestamp
          )`);
    psql('create index profiles_email_idx on kortix_yolo.profiles using btree (email)');
    psql('create index profiles_role_idx on kortix_yolo.profiles using btree (role)');
    psql(
      `insert into kortix_yolo.profiles (id, email, role) values (gen_random_uuid(), 'user-1@example.test', 'member')`,
    );
    expect(psql('select count(*) from kortix_yolo.profiles')).toBe('1');
    // Re-run only the migration under test: drop its ledger row, then migrate.
    psql(`delete from kortix_migrations.pgmigrations where name like '${MIGRATION}%'`);
    const code = await runMigrate(ROOT, ports);
    expect(code).toBe(0);
    // The flagged index is gone.
    expect(
      psql(
        `select count(*) from pg_indexes
         where schemaname = 'kortix_yolo' and tablename = 'profiles'
           and indexname = 'profiles_email_idx'`,
      ),
    ).toBe('0');
    // The pkey and the unflagged role index survive the drop.
    expect(
      psql(
        `select indexname from pg_indexes
         where schemaname = 'kortix_yolo' and tablename = 'profiles'
         order by 1`,
      ),
    ).toBe('profiles_pkey\nprofiles_role_idx');
    expect(psql('select count(*) from kortix_yolo.profiles')).toBe('1');
    // The IF EXISTS path is safe to re-run: a re-applied migration (ledger row
    // dropped again) exits green and leaves the same two indexes behind.
    psql(`delete from kortix_migrations.pgmigrations where name like '${MIGRATION}%'`);
    const again = await runMigrate(ROOT, ports);
    expect(again).toBe(0);
    expect(
      psql(
        `select count(*) from pg_indexes
         where schemaname = 'kortix_yolo' and tablename = 'profiles'`,
      ),
    ).toBe('2');
  }, 180_000);
});

if (!dockerOk) {
  // biome-ignore lint/suspicious/noSkippedTests: This integration suite requires a running Docker daemon.
  test.skip('kortix_yolo profiles unused index integration (docker unavailable — skipped)', () => {});
}
