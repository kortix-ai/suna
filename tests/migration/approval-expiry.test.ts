// Approval expiry: 20261020162514189_approval_expiry.sql adds the `expired`
// value to kortix.connector_call_status, connector_calls.expires_at and
// connector_project_settings.approval_ttl_seconds;
// 20261020162524287_approval_expiry_index.concurrent.ts builds the partial index
// the expiry worker's sweep reads.
//
// What this proves, on one throwaway Postgres migrated from empty:
//   - the enum carries `expired` and a row can be written with it (the value
//     committed before any later statement used it);
//   - both columns exist and are nullable (existing rows never expire);
//   - the partial index is VALID, on expires_at, scoped to pending rows;
//   - both migrations record themselves in the ledger.
//
//   bun test tests/migration/approval-expiry.test.ts   (needs docker)
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ports, computePorts, repoRoot, runMigrate, sh } from '../../scripts/worktree/lib';

const dockerOk = sh(['docker', 'info']).ok;
const CONTAINER = 'kortix-approval-expiry-migration-test';
// Below 32768 for the reason given in worktree-migrate.test.ts.
const PORT = Number(process.env.APPROVAL_EXPIRY_TEST_PORT || 5454);
const ROOT = repoRoot();
const ports: Ports = { ...computePorts(0), sbDb: PORT };
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const INDEX = 'idx_connector_calls_pending_expiry';

function psql(query: string): string {
  const res = sh(['psql', URL, '-v', 'ON_ERROR_STOP=1', '-tA', '-c', query]);
  if (!res.ok) throw new Error(`psql failed: ${res.stderr}\n${query}`);
  return res.stdout.trim();
}

const pgReady = (): boolean => sh(['psql', URL, '-tAc', 'select 1']).ok;

const suite = dockerOk ? describe : describe.skip;

suite('approval expiry migrations (throwaway Postgres)', () => {
  beforeAll(async () => {
    sh(['docker', 'rm', '-f', '-v', CONTAINER]);
    const up = sh([
      'docker', 'run', '-d', '--name', CONTAINER,
      '-e', 'POSTGRES_PASSWORD=postgres', '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_DB=postgres',
      '--tmpfs', '/var/lib/postgresql/data',
      '-p', `127.0.0.1:${PORT}:5432`,
      'postgres:16-alpine',
      '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off',
    ]);
    if (!up.ok) throw new Error(`could not start test container: ${up.stderr}`);
    for (let i = 0; i < 60 && !pgReady(); i++) await Bun.sleep(1000);
    if (!pgReady()) throw new Error('test Postgres never became ready');
    if ((await runMigrate(ROOT, ports)) !== 0) throw new Error('migrations failed');
  }, 480_000);

  afterAll(() => {
    sh(['docker', 'rm', '-f', '-v', CONTAINER]);
  });

  test('connector_call_status carries expired', () => {
    expect(psql(`select 'expired' = any(enum_range(null::kortix.connector_call_status)::text[])`)).toBe('t');
  });

  test('expires_at and approval_ttl_seconds are nullable columns', () => {
    expect(
      psql(`select column_name || ':' || is_nullable from information_schema.columns
             where table_schema = 'kortix'
               and ((table_name = 'connector_calls' and column_name = 'expires_at')
                 or (table_name = 'connector_project_settings' and column_name = 'approval_ttl_seconds'))
             order by column_name`).split('\n'),
    ).toEqual(['approval_ttl_seconds:YES', 'expires_at:YES']);
  });

  test('the partial index is valid, on expires_at, for pending rows only', () => {
    expect(
      psql(`select i.indisvalid from pg_class c join pg_index i on i.indexrelid = c.oid where c.relname = '${INDEX}'`),
    ).toBe('t');
    const def = psql(`select indexdef from pg_indexes where indexname = '${INDEX}'`);
    expect(def).toContain('(expires_at)');
    expect(def).toContain(`WHERE (status = 'pending_approval'`);
  });

  test('a row can be written as expired', () => {
    psql(`
      insert into kortix.accounts (account_id, name)
      values ('11111111-1111-4111-8111-111111111111', 'seed account') on conflict do nothing;
      insert into kortix.projects (project_id, account_id, name, repo_url, default_branch, manifest_path, status)
      values ('22222222-2222-4222-8222-222222222201', '11111111-1111-4111-8111-111111111111', 'seed project',
              'https://example.test/seed/main', 'main', 'kortix.yaml', 'active') on conflict do nothing;
      insert into kortix.connector_calls (account_id, project_id, action_path, status, expires_at, resolved_at)
      values ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222201',
              'seed.send', 'expired', now() - interval '1 minute', now());`);
    expect(psql(`select count(*) from kortix.connector_calls where status = 'expired'`)).toBe('1');
  });

  test('both migrations record themselves in the ledger', () => {
    expect(
      psql(`select count(*) from kortix_migrations.pgmigrations
             where name in ('20261020162514189_approval_expiry', '20261020162524287_approval_expiry_index.concurrent')`),
    ).toBe('2');
  });
});
