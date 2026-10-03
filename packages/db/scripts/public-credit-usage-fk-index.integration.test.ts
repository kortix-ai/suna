/**
 * The legacy `public.credit_usage` foreign-key index, against a real
 * PostgreSQL.
 *
 * Databases that predate the Kortix baseline still carry the basejump-era
 * `public.credit_usage` table. Its FK `credit_usage_message_id_fkey`
 * (message_id -> messages.message_id, ON DELETE SET NULL) has no covering
 * index, so every DELETE on `messages` must seq-scan `public.credit_usage`
 * to null the references — the exact shape Supabase's
 * `0001_unindexed_foreign_keys` lint flags (KRTX-1123). The migration builds
 * the missing index CONCURRENTLY, but only where the legacy table exists:
 * fresh databases never create it (the baseline builds only
 * `kortix.credit_usage`), and a CREATE INDEX CONCURRENTLY on a missing
 * relation would fail the migrate step for them.
 *
 * The covering-index predicate below mirrors Supabase's lint: an index
 * covers an FK when the FK's columns are a prefix of the index's columns.
 * The migration runs through node-pg-migrate's own runner, the way
 * `pnpm migrate` runs it — single-transaction batch plus the
 * `pgm.noTransaction()` opt-out this migration needs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dockerAvailable } from './docker-available';

const container = `kortix-credit-usage-fk-idx-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_public_credit_usage_message_id_index.concurrent.ts').scanSync({
    cwd: migrationDirectory,
  }),
);
let containerStarted = false;
let port = 0;
let stagingDir = '';
let migrationFile = '';

function dockerPsql(database: string, sql: string) {
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
      database,
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

/** The legacy shape: three FKs, two of them already covered by indexes. */
function legacyFixture(): string {
  return `
    CREATE TABLE public.accounts (account_id uuid PRIMARY KEY);
    CREATE TABLE public.messages (message_id uuid PRIMARY KEY, payload text);
    CREATE TABLE public.threads (thread_id uuid PRIMARY KEY);
    CREATE TABLE public.credit_usage (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id uuid NOT NULL,
      amount_dollars numeric(10,2) NOT NULL CHECK (amount_dollars > 0),
      thread_id uuid,
      message_id uuid,
      description text,
      usage_type text DEFAULT 'token_overage'
        CHECK (usage_type = ANY (ARRAY['token_overage','manual_deduction','adjustment'])),
      created_at timestamptz DEFAULT now(),
      subscription_tier text,
      metadata jsonb DEFAULT '{}'::jsonb,
      CONSTRAINT credit_usage_user_id_fkey FOREIGN KEY (account_id)
        REFERENCES public.accounts(account_id) ON DELETE CASCADE,
      CONSTRAINT credit_usage_thread_id_fkey FOREIGN KEY (thread_id)
        REFERENCES public.threads(thread_id) ON DELETE SET NULL,
      CONSTRAINT credit_usage_message_id_fkey FOREIGN KEY (message_id)
        REFERENCES public.messages(message_id) ON DELETE SET NULL
    );
    CREATE INDEX idx_credit_usage_account_id ON public.credit_usage USING btree (account_id);
    CREATE INDEX idx_credit_usage_created_at ON public.credit_usage USING btree (created_at DESC);
    CREATE INDEX idx_credit_usage_thread_id ON public.credit_usage USING btree (thread_id);
    INSERT INTO public.accounts (account_id) VALUES (gen_random_uuid());
    INSERT INTO public.messages (message_id, payload)
      SELECT gen_random_uuid(), 'seed' FROM generate_series(1, 5);
    INSERT INTO public.credit_usage (account_id, amount_dollars, message_id)
      SELECT (SELECT account_id FROM public.accounts LIMIT 1), 1.00, message_id
      FROM (SELECT message_id FROM public.messages LIMIT 3) m;
  `;
}

/** Supabase lint 0001: the FK's columns must be a prefix of some valid
 *  index's columns. Returns the FK names it still finds uncovered. */
function uncoveredForeignKeys(database: string): string[] {
  const rows = dockerPsql(
    database,
    `SELECT con.conname
       FROM pg_catalog.pg_constraint con
       WHERE con.conrelid = 'public.credit_usage'::regclass
         AND con.contype = 'f'
         AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_index i
           WHERE i.indrelid = con.conrelid
             AND (i.indkey::int2[])[0:array_length(con.conkey, 1) - 1] @> con.conkey
             AND i.indisvalid
         )
       ORDER BY con.conname`,
  );
  return rows.length === 0 ? [] : rows.split('\n');
}

function messageIndex(database: string): string {
  return dockerPsql(
    database,
    `SELECT count(*) FILTER (WHERE i.indisvalid)
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
       JOIN pg_catalog.pg_class t ON t.oid = i.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = 'credit_usage'
        AND c.relname = 'idx_credit_usage_message_id'`,
  );
}

function indexCount(database: string): string {
  return dockerPsql(
    database,
    `SELECT count(*) FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public' AND tablename = 'credit_usage'`,
  );
}

/** Apply the migration through node-pg-migrate's runner, from the host,
 *  exactly like packages/db/scripts/migrate.ts configures it. */
async function applyMigration(database: string): Promise<void> {
  const { runner } = await import('node-pg-migrate');
  await runner({
    databaseUrl: `postgres://postgres:test@127.0.0.1:${port}/${database}`,
    dir: stagingDir,
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'kortix_migrations',
    createMigrationsSchema: true,
    checkOrder: false,
    singleTransaction: true,
    direction: 'up',
    verbose: false,
    logger: console,
  });
}

describe.skipIf(!dockerAvailable)(
  'public.credit_usage message_id FK index — real PostgreSQL',
  () => {
    beforeAll(async () => {
      if (migrationNames.length !== 1) return;
      migrationFile = migrationNames[0] ?? '';

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
        'postgres:16-alpine',
      ]);
      if (started.exitCode !== 0) throw new Error(started.stderr.toString());
      containerStarted = true;

      for (let attempt = 0; attempt < 50; attempt += 1) {
        // TCP, never the unix socket: initdb runs a temporary socket-only
        // server whose readiness says nothing about the real one.
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
            '-c',
            'SELECT 1',
          ],
          { stdout: 'ignore', stderr: 'ignore' },
        );
        if (probe.exitCode === 0) break;
        if (attempt === 49) throw new Error('Disposable PostgreSQL did not become ready');
        await Bun.sleep(250);
      }

      port = Number(
        Bun.spawnSync(['docker', 'port', container, '5432/tcp'], { stdout: 'pipe', stderr: 'pipe' })
          .stdout.toString()
          .trim()
          .split(':')
          .at(-1),
      );
      // The runner imports the migration file itself: stage the single file in
      // a scratch directory so this suite applies only this migration.
      stagingDir = mkdtempSync(join(tmpdir(), 'pgm-credit-usage-'));
      cpSync(join(migrationDirectory, migrationFile), join(stagingDir, migrationFile));
    }, 60_000);

    afterAll(() => {
      if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
      if (!containerStarted) return;
      Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
    });

    test('the migration file exists exactly once', () => {
      expect(migrationNames).toHaveLength(1);
    });

    test('the flagged FK starts uncovered, and the migration covers exactly it', async () => {
      dockerPsql('postgres', 'CREATE DATABASE fk_db');
      dockerPsql('fk_db', legacyFixture());
      // RED: the exact condition the Supabase advisor reports on prod.
      expect(uncoveredForeignKeys('fk_db')).toEqual(['credit_usage_message_id_fkey']);
      // pg_indexes counts the pkey index too (verified against prod: 4 rows,
      // credit_usage_pkey included).
      expect(indexCount('fk_db')).toBe('4');

      // GREEN: the real migration, applied the way `pnpm migrate` applies it.
      await applyMigration('fk_db');
      expect(uncoveredForeignKeys('fk_db')).toEqual([]);
      expect(messageIndex('fk_db')).toBe('1');
      expect(indexCount('fk_db')).toBe('5');
      // Nothing else changed: the three FK constraints survive.
      expect(
        dockerPsql(
          'fk_db',
          "SELECT count(*) FROM pg_constraint WHERE conrelid='public.credit_usage'::regclass AND contype='f'",
        ),
      ).toBe('3');
    }, 60_000);

    test('a second run is a no-op', async () => {
      await expect(applyMigration('fk_db')).resolves.toBeUndefined();
      expect(messageIndex('fk_db')).toBe('1');
      expect(indexCount('fk_db')).toBe('5');
    }, 60_000);

    test('is a safe no-op on a fresh database that never had the legacy table', async () => {
      dockerPsql('postgres', 'CREATE DATABASE fresh_db');
      // A fresh environment has no public.credit_usage: an unconditional
      // CREATE INDEX CONCURRENTLY would fail the whole migrate batch here.
      await expect(applyMigration('fresh_db')).resolves.toBeUndefined();
      expect(dockerPsql('fresh_db', "SELECT to_regclass('public.credit_usage') IS NULL")).toBe('t');
      // The skip is still recorded as applied, so `migrate:status` stays clean.
      expect(
        dockerPsql(
          'fresh_db',
          `SELECT count(*) FROM kortix_migrations.pgmigrations
          WHERE name LIKE '%public_credit_usage_message_id_index%'`,
        ),
      ).toBe('1');
    }, 60_000);
  },
);
