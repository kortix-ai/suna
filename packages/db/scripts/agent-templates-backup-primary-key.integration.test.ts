import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { dockerAvailable } from './docker-available';

const container = `kortix-agent-templates-backup-pk-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_add_agent_templates_backup_primary_key.sql').scanSync({
    cwd: migrationDirectory,
  }),
);
let containerStarted = false;

function dockerPsql(sql: string) {
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

// prod legacy shape (read-only catalog check, 2026-10-04): 17 columns, every
// one nullable with no default, zero constraints, zero indexes, 2 archived
// rows, both with a NULL template_id. The migration's behavior depends only on
// "the table exists and has no primary key", so the fixture models those facts
// with a subset of the columns, not the full 17.
const SEED = `
  drop table if exists public.agent_templates_backup;
  create table public.agent_templates_backup (
    template_id uuid,
    name character varying,
    is_public boolean,
    created_at timestamp with time zone
  );
  insert into public.agent_templates_backup (name, is_public, created_at) values
    ('first', true, '2025-07-01T00:00:00Z'),
    ('second', false, '2025-07-02T00:00:00Z');
`;

function primaryKeys() {
  return dockerPsql(`
    select conname || ':' || pg_get_constraintdef(oid)
    from pg_constraint
    where conrelid = 'public.agent_templates_backup'::regclass and contype = 'p'
  `);
}

describe.skipIf(!dockerAvailable)(
  'agent_templates_backup primary key migration — real PostgreSQL',
  () => {
    beforeAll(async () => {
      if (migrationNames.length !== 1) return;

      const started = Bun.spawnSync(
        [
          'docker',
          'run',
          '--rm',
          '-d',
          '--name',
          container,
          '-e',
          'POSTGRES_PASSWORD=test',
          '-e',
          'POSTGRES_DB=testdb',
          'postgres:16-alpine',
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      if (started.exitCode !== 0) throw new Error(started.stderr.toString());
      containerStarted = true;

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const probe = Bun.spawnSync(
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
            'SELECT 1',
          ],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        if (probe.exitCode === 0) return;
        await Bun.sleep(250);
      }

      throw new Error('Disposable PostgreSQL did not become ready');
    }, 30_000);

    afterAll(() => {
      if (!containerStarted) return;
      Bun.spawnSync(['docker', 'rm', '-f', '-v', container], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
    });

    test('absent table: the migration is a no-op (fresh databases never have it)', async () => {
      expect(migrationNames).toHaveLength(1);
      const migration = await Bun.file(resolve(migrationDirectory, migrationNames[0])).text();

      dockerPsql('drop table if exists public.agent_templates_backup;');
      dockerPsql(migration);

      expect(dockerPsql("select to_regclass('public.agent_templates_backup') is null")).toBe('t');
    });

    test('legacy table: adds the surrogate primary key and preserves the archived rows', async () => {
      const migration = await Bun.file(resolve(migrationDirectory, migrationNames[0])).text();

      dockerPsql(SEED);
      dockerPsql(migration);

      // Exactly one primary key, on the surrogate column.
      expect(primaryKeys()).toBe('agent_templates_backup_pkey:PRIMARY KEY (backup_id)');

      // The archived rows survive with their original values, and each gains
      // a distinct, non-null identity value.
      expect(
        dockerPsql(`
          select name || ':' || coalesce(template_id::text, '<NULL>') || ':' || is_public::text
          from public.agent_templates_backup order by backup_id
        `),
      ).toBe('first:<NULL>:true\nsecond:<NULL>:false');
      expect(
        dockerPsql('select count(distinct backup_id), count(backup_id) from public.agent_templates_backup'),
      ).toBe('2|2');

      // The identity column serves new rows without being named.
      dockerPsql("insert into public.agent_templates_backup (name) values ('third')");
      expect(dockerPsql('select count(*) from public.agent_templates_backup')).toBe('3');

      // Re-running the migration changes nothing (already-fixed guard).
      dockerPsql(migration);
      expect(primaryKeys()).toBe('agent_templates_backup_pkey:PRIMARY KEY (backup_id)');
      expect(dockerPsql('select count(*) from public.agent_templates_backup')).toBe('3');
    });

    test('backup_id without a primary key (manual partial state): the migration is a no-op', async () => {
      const migration = await Bun.file(resolve(migrationDirectory, migrationNames[0])).text();

      // The state a manual half-application would leave: the surrogate column
      // exists, the primary key does not.
      dockerPsql(
        `drop table if exists public.agent_templates_backup;
         create table public.agent_templates_backup (template_id uuid, backup_id bigint);`,
      );
      dockerPsql(migration);

      expect(primaryKeys()).toBe('');
      expect(
        dockerPsql(
          "select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'agent_templates_backup' and column_name = 'backup_id'",
        ),
      ).toBe('1');
    });
  },
);
