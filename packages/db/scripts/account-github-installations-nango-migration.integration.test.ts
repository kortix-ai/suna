import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { up as buildNangoConnectionIndex } from '../migrations/20260727170412686_account_github_installation_nango_connection_index.concurrent';

const dockerAvailable =
  Bun.spawnSync(['docker', 'version'], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).exitCode === 0;

const container = `kortix-nango-migration-${crypto.randomUUID().slice(0, 8)}`;
const databases = ['emptydb', 'populateddb'] as const;

function dockerPsql(
  database: (typeof databases)[number] | 'postgres',
  sql: string,
  allowFailure = false,
) {
  const result = Bun.spawnSync(
    [
      'docker',
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      database,
      '-v',
      'ON_ERROR_STOP=1',
      '-t',
      '-A',
    ],
    { stdin: Buffer.from(sql), stdout: 'pipe', stderr: 'pipe' },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (!allowFailure && result.exitCode !== 0) throw new Error(output);
  return { exitCode: result.exitCode, output };
}

const PRE_MIGRATION_SCHEMA = `
  CREATE SCHEMA kortix;
  CREATE TABLE kortix.accounts (
    account_id uuid PRIMARY KEY
  );
  CREATE TABLE kortix.account_github_installations (
    installation_row_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
    installation_id text NOT NULL,
    owner_login varchar(255) NOT NULL,
    owner_type varchar(32) NOT NULL DEFAULT 'Organization',
    repository_selection varchar(32),
    permissions jsonb DEFAULT '{}'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX idx_account_github_installations_account_installation
    ON kortix.account_github_installations (account_id, installation_id);
`;

async function migrationSql() {
  return Bun.file(
    resolve(
      import.meta.dir,
      '..',
      'migrations',
      '20260727170351545_add_account_github_installation_nango.sql',
    ),
  ).text();
}

async function statusConstraintMigrations() {
  const names = [
    '20260727171251064_constrain_account_github_connection_status.sql',
    '20260727171259985_validate_account_github_connection_status.sql',
  ];
  return Promise.all(
    names.map((name) => Bun.file(resolve(import.meta.dir, '..', 'migrations', name)).text()),
  );
}

function concurrentIndexStatements(): string[] {
  const statements: string[] = [];
  buildNangoConnectionIndex({
    noTransaction() {},
    sql(statement: string) {
      statements.push(statement);
    },
  });
  return statements;
}

describe.skipIf(!dockerAvailable)('account GitHub Nango migration - real PostgreSQL', () => {
  beforeAll(async () => {
    const started = Bun.spawnSync([
      'docker',
      'run',
      '--rm',
      '-d',
      '--name',
      container,
      '-e',
      'POSTGRES_PASSWORD=test',
      'postgres:16-alpine',
    ]);
    if (started.exitCode !== 0) throw new Error(started.stderr.toString());

    let ready = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = Bun.spawnSync(
        ['docker', 'exec', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-c', 'SELECT 1'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) {
        ready = true;
        break;
      }
      await Bun.sleep(250);
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');

    for (const database of databases) {
      dockerPsql('postgres', `CREATE DATABASE ${database};`);
      dockerPsql(database, PRE_MIGRATION_SCHEMA);
    }

    dockerPsql(
      'populateddb',
      `
          INSERT INTO kortix.accounts (account_id) VALUES
            ('00000000-0000-4000-a000-000000000001'),
            ('00000000-0000-4000-a000-000000000002');
          INSERT INTO kortix.account_github_installations
            (account_id, installation_id, owner_login)
          VALUES
            ('00000000-0000-4000-a000-000000000001', '123456', 'owner-one'),
            ('00000000-0000-4000-a000-000000000002', '123456', 'owner-two');
        `,
    );

    const sql = await migrationSql();
    const constraintMigrations = await statusConstraintMigrations();
    const indexStatements = concurrentIndexStatements();
    for (const database of databases) {
      dockerPsql(database, sql);
      for (const statement of indexStatements) {
        dockerPsql(database, statement);
      }
      for (const migration of constraintMigrations) {
        dockerPsql(database, migration);
      }
    }
  }, 30_000);

  afterAll(() => {
    Bun.spawnSync(['docker', 'rm', '-f', container], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
  });

  test('applies all nullable fields to empty and populated tables', () => {
    for (const database of databases) {
      const columns = dockerPsql(
        database,
        `
            SELECT column_name || ':' || is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'kortix'
              AND table_name = 'account_github_installations'
              AND column_name IN (
                'nango_connection_id',
                'nango_integration_id',
                'connection_status',
                'last_validated_at',
                'last_error_code',
                'last_error_message',
                'disconnected_at'
              )
            ORDER BY column_name;
          `,
      );
      const rows = columns.output.trim().split('\n');
      expect(rows).toHaveLength(7);
      expect(rows.every((row) => row.endsWith(':YES'))).toBe(true);
    }
  });

  test('preserves legacy rows and shared GitHub installation identifiers', () => {
    const rows = dockerPsql(
      'populateddb',
      `
          SELECT installation_id, nango_connection_id
          FROM kortix.account_github_installations
          ORDER BY owner_login;
        `,
    );
    expect(rows.output.trim().split('\n')).toEqual(['123456|', '123456|']);
  });

  test('permits null Nango IDs and rejects duplicate non-null IDs', () => {
    const validity = dockerPsql(
      'populateddb',
      `
          SELECT i.indisvalid
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'kortix'
            AND c.relname = 'idx_account_github_installations_nango_connection';
        `,
    );
    expect(validity.output.trim()).toBe('t');

    dockerPsql(
      'populateddb',
      `
          UPDATE kortix.account_github_installations
          SET nango_connection_id = 'opaque-nango-id'
          WHERE owner_login = 'owner-one';
        `,
    );
    const duplicate = dockerPsql(
      'populateddb',
      `
          \\set VERBOSITY verbose
          UPDATE kortix.account_github_installations
          SET nango_connection_id = 'opaque-nango-id'
          WHERE owner_login = 'owner-two';
        `,
      true,
    );

    expect(duplicate.exitCode).not.toBe(0);
    expect(duplicate.output).toContain('23505');
    expect(duplicate.output).toContain('idx_account_github_installations_nango_connection');
  });

  test('rejects connection states outside the lifecycle contract', () => {
    const invalid = dockerPsql(
      'populateddb',
      `
          \\set VERBOSITY verbose
          UPDATE kortix.account_github_installations
          SET connection_status = 'invalid_state'
          WHERE owner_login = 'owner-two';
        `,
      true,
    );

    expect(invalid.exitCode).not.toBe(0);
    expect(invalid.output).toContain('23514');
    expect(invalid.output).toContain('account_github_installations_connection_status_check');
  });
});

describe('account GitHub Nango migration shape', () => {
  test('keeps unrelated tables and blocking index creation out of the SQL migration', async () => {
    const sql = await migrationSql();

    expect(sql).not.toContain('voice_call_read_cursors');
    expect(sql).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(sql).not.toMatch(/\b(drop|rename)\b/i);
  });

  test('builds the partial unique index concurrently', () => {
    const statements = concurrentIndexStatements();

    expect(statements).toHaveLength(2);
    expect(statements[1]).toMatch(/create unique index concurrently/i);
    expect(statements[1]).not.toMatch(/if not exists/i);
    expect(statements[1]).toMatch(/where nango_connection_id is not null/i);
  });
});
