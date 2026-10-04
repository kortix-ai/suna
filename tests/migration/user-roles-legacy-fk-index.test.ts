import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ports, computePorts, repoRoot, runMigrate, sh, waitForPostgresReady } from '../../scripts/worktree/lib';

// The public.user_roles legacy table is not a migration object: the migrations
// neither create nor manage it (it predates the kortix schema; the live roles
// live in kortix.platform_user_roles). The user_roles_granted_by_index migration
// must therefore guard its CREATE INDEX CONCURRENTLY on the table's existence:
//
//   - on every fresh database (self-host bootstrap, CI shadow, preview) the
//     table is absent, so the whole migration chain must still apply; and
//   - where the legacy table exists (prod), the FK user_roles_granted_by_fkey
//     must get its covering index, or the advisor finding stays and every
//     auth.users delete seq-scans the table.
//
//   bun test tests/migration/user-roles-legacy-fk-index.test.ts   (needs docker)

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-user-roles-fk-index-test';
// Host port for the throwaway container. MUST stay BELOW 32768: Linux's default
// ephemeral range is 32768-60999 (`/proc/sys/net/ipv4/ip_local_port_range`), and
// an outbound socket from the suite can transiently own a port in it — Docker
// then fails the run with `bind: address already in use`.
const PORT = Number(process.env.USER_ROLES_FK_INDEX_TEST_PORT || 5448);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
// The ledger stores basename-minus-extension, so the .concurrent.ts file is
// `..._user_roles_granted_by_index.concurrent`.
const MIGRATION = '20261002214110302_user_roles_granted_by_index';

function psql(sql: string): string {
  const res = sh(['psql', URL, '-v', 'ON_ERROR_STOP=1', '-tAc', sql]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${sql}`);
  return res.stdout.trim();
}

const suite = dockerOk ? describe : describe.skip;

suite('user_roles granted_by FK index (throwaway Postgres)', () => {
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
    await waitForPostgresReady(URL);
  }, 300_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', CONTAINER]);
  });

  test('applies green where the legacy table does not exist (fresh database)', async () => {
    const code = await runMigrate(ROOT, ports);
    expect(code).toBe(0);
    expect(psql("select to_regclass('public.user_roles') is null")).toBe('t');
    expect(psql("select to_regclass('public.idx_user_roles_granted_by') is null")).toBe('t');
  }, 180_000);

  test('builds a valid index where the legacy table exists (prod shape)', async () => {
    // Mirror the prod legacy table (synthetic rows only): pkey on user_id, the
    // granted_by FK the advisor flags, no index on granted_by.
    psql(`create table public.user_roles (
            user_id uuid primary key references auth.users(id) on delete cascade,
            role text not null default 'user',
            granted_by uuid references auth.users(id),
            granted_at timestamptz not null default now(),
            metadata jsonb
          )`);
    psql('insert into auth.users (id) values (gen_random_uuid())');
    psql(
      'insert into public.user_roles (user_id, granted_by) select id, id from auth.users limit 1',
    );
    expect(psql('select count(*) from public.user_roles')).toBe('1');
    // Re-run only the migration under test: drop its ledger row, then migrate.
    psql(`delete from kortix_migrations.pgmigrations where name like '${MIGRATION}%'`);
    const code = await runMigrate(ROOT, ports);
    expect(code).toBe(0);
    expect(
      psql(`select i.indisvalid and i.indisready
            from pg_index i join pg_class c on c.oid = i.indexrelid
            where c.relname = 'idx_user_roles_granted_by'`),
    ).toBe('t');
    expect(
      psql(`select indexdef from pg_indexes
            where schemaname = 'public' and tablename = 'user_roles'
              and indexname = 'idx_user_roles_granted_by'`),
    ).toBe('CREATE INDEX idx_user_roles_granted_by ON public.user_roles USING btree (granted_by)');
    // The guarded build never leaves an INVALID index behind on re-run: re-run
    // the migration again through the IF NOT EXISTS branch (drop the ledger row
    // so the runner actually applies it).
    psql(`delete from kortix_migrations.pgmigrations where name like '${MIGRATION}%'`);
    const again = await runMigrate(ROOT, ports);
    expect(again).toBe(0);
    expect(
      psql(`select count(*) from pg_index i join pg_class c on c.oid = i.indexrelid
            where c.relname = 'idx_user_roles_granted_by'`),
    ).toBe('1');
  }, 180_000);
});

if (!dockerOk) {
  // biome-ignore lint/suspicious/noSkippedTests: This integration suite requires a running Docker daemon.
  test.skip('user_roles legacy FK index integration (docker unavailable — skipped)', () => {});
}
