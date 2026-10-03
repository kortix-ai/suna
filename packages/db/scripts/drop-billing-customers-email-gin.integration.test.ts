/**
 * The `basejump.billing_customers` email-GIN index drop, against a real
 * PostgreSQL.
 *
 * Prod carries `idx_billing_customers_email_gin` (GIN trigram on
 * lower(email)) with `idx_scan = 0` — the Supabase advisor's `unused_index`
 * finding. No migration built it (basejump package drift) and no code reads
 * it. The migration must drop exactly that index in one CONCURRENTLY
 * statement, keep the table's used indexes and its rows, re-run cleanly
 * (IF EXISTS), and no-op where basejump does not exist at all (fresh
 * self-host installs).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { dockerAvailable } from './docker-available';

const container = `kortix-drop-billing-email-gin-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationName = Array.from(
  new Bun.Glob('*_drop_unused_billing_customers_email_gin_index.concurrent.ts').scanSync({
    cwd: migrationDirectory,
  }),
).at(0);

/** The migration's SQL statements, read from the file through its own
 *  `pgm.sql()` calls so the test exercises the real file, not a copy. */
async function migrationStatements(): Promise<string[]> {
  if (!migrationName) throw new Error('migration file not found');
  const statements: string[] = [];
  let noTransaction = false;
  const pgm = {
    sql: (statement: string) => statements.push(statement),
    noTransaction: () => {
      noTransaction = true;
    },
  };
  const { up } = await import(resolve(migrationDirectory, migrationName));
  up(pgm);
  expect(noTransaction).toBe(true);
  return statements;
}

function psql(sql: string) {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-h',
      '127.0.0.1',
      '-U',
      'postgres',
      '-d',
      'testdb',
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== 0) throw new Error(output);
  return output.trim();
}

/** Each statement in its own session — CONCURRENTLY cannot run inside a
 *  transaction, which is exactly the noTransaction contract the migration
 *  declares. */
function applyStatements(statements: string[]) {
  for (const statement of statements) psql(statement);
}

const FIXTURE = `
  create extension if not exists pg_trgm;
  create schema basejump;
  create table basejump.billing_customers (
    id uuid primary key,
    account_id uuid not null,
    email text,
    active boolean,
    provider text
  );
  create index idx_billing_customers_email_gin
    on basejump.billing_customers using gin (lower(email) gin_trgm_ops);
  create index idx_billing_customers_account_id
    on basejump.billing_customers (account_id);
  insert into basejump.billing_customers values
    ('00000000-0000-4000-a000-000000000001', '00000000-0000-4000-b000-000000000001',
     'demo@example.test', true, 'stripe'),
    ('00000000-0000-4000-a000-000000000002', '00000000-0000-4000-b000-000000000002',
     'demo2@example.test', true, 'stripe');
`;

describe.skipIf(!dockerAvailable)('drop basejump billing email GIN index — real PostgreSQL', () => {
  beforeAll(async () => {
    const started = Bun.spawnSync([
      'docker',
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-p',
      '127.0.0.1::5432',
      '-e',
      'POSTGRES_PASSWORD=test',
      '-e',
      'POSTGRES_DB=testdb',
      'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const probe = Bun.spawnSync(
        // OVER TCP (-h), never the default unix socket. The postgres image runs
        // a TEMPORARY server during initdb that listens on the SOCKET ONLY, so
        // a socket probe goes green while that one is up — and the real
        // server's restart then fails the very next statement with
        // "connection to server on socket ... No such file or directory".
        // A TCP probe cannot see the temporary server at all, so passing it
        // means the real one is up.
        [
          'docker',
          'exec',
          container,
          'psql',
          '-h',
          '127.0.0.1',
          '-U',
          'postgres',
          '-d',
          'testdb',
          '-c',
          'select 1',
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) return;
      await Bun.sleep(250);
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  }, 30_000);

  beforeEach(() => psql(FIXTURE));

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('drops the GIN index and keeps the used indexes and the rows', async () => {
    applyStatements(await migrationStatements());

    const indexes = psql(
      `select indexrelname from pg_stat_user_indexes where schemaname = 'basejump' and relname = 'billing_customers' order by indexrelname`,
    );
    expect(indexes).toBe('billing_customers_pkey\nidx_billing_customers_account_id');

    const rows = psql('select count(*) from basejump.billing_customers');
    expect(rows).toBe('2');
  });

  test('re-running the migration is a no-op (IF EXISTS)', async () => {
    applyStatements(await migrationStatements());
    applyStatements(await migrationStatements());

    const indexes = psql(
      `select count(*) from pg_stat_user_indexes where schemaname = 'basejump' and relname = 'billing_customers' and indexrelname = 'idx_billing_customers_email_gin'`,
    );
    expect(indexes).toBe('0');
  });

  test('no-ops where basejump does not exist (fresh self-host)', async () => {
    applyStatements(await migrationStatements());
    psql('drop schema basejump cascade');
    applyStatements(await migrationStatements());

    const schema = psql(`select count(*) from pg_namespace where nspname = 'basejump'`);
    expect(schema).toBe('0');
  });

  test('drops exactly one CONCURRENTLY statement — the file says so', async () => {
    const statements = await migrationStatements();
    const concurrent = statements.filter((statement) => /\bconcurrently\b/i.test(statement));
    expect(concurrent).toEqual([
      'drop index concurrently if exists "basejump"."idx_billing_customers_email_gin"',
    ]);
  });
});
