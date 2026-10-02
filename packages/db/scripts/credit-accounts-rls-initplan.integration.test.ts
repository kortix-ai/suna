/**
 * The `auth_rls_initplan` fix for the legacy `public.credit_accounts`, against
 * a real PostgreSQL.
 *
 * The Supabase performance advisor flags RLS policies that call
 * `auth.<function>()` bare: the call is re-evaluated for every filtered row.
 * The remediation wraps each call in a scalar subquery so the planner builds an
 * InitPlan and evaluates it once per statement. This test pins the migration's
 * three contracts: the advisor's own predicate stops flagging the table, the
 * policies keep their roles/command/permissiveness (ALTER POLICY, not a
 * recreate), and the migration is a no-op everywhere the legacy table or a
 * policy is absent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { dockerAvailable } from './docker-available';

const container = `kortix-credit-rls-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_credit_accounts_rls_initplan.sql').scanSync({ cwd: migrationDirectory }),
);
let containerStarted = false;
let migration = '';

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

/** node-pg-migrate runs each file in one transaction; mirror that. */
function applyMigration(database: string) {
  return dockerPsql(database, `BEGIN;\n${migration}\nCOMMIT;\n`);
}

/**
 * The where-clause of supabase/splinter lints/0003_auth_rls_initplan.sql
 * (the predicate the prod advisor runs), on the core catalog. A policy is
 * flagged when its qual or with_check names an auth function (or
 * current_setting) and the call is not wrapped in a `select` subquery. A NULL
 * with_check matches nothing, exactly as in the lint's own SQL.
 */
function advisorFlags(database: string): number {
  return Number(
    dockerPsql(
      database,
      `SELECT count(*)
         FROM pg_policy pa
         JOIN pg_class pc ON pa.polrelid = pc.oid
         JOIN pg_namespace nsp ON pc.relnamespace = nsp.oid
        WHERE pc.relrowsecurity
          AND nsp.nspname = 'public' AND pc.relname = 'credit_accounts'
          AND (
            (pg_get_expr(pa.polqual, pa.polrelid) LIKE '%auth.uid()%' AND lower(pg_get_expr(pa.polqual, pa.polrelid)) NOT LIKE '%select auth.uid()%')
         OR (pg_get_expr(pa.polqual, pa.polrelid) LIKE '%auth.jwt()%' AND lower(pg_get_expr(pa.polqual, pa.polrelid)) NOT LIKE '%select auth.jwt()%')
         OR (pg_get_expr(pa.polqual, pa.polrelid) LIKE '%auth.role()%' AND lower(pg_get_expr(pa.polqual, pa.polrelid)) NOT LIKE '%select auth.role()%')
         OR (pg_get_expr(pa.polqual, pa.polrelid) LIKE '%auth.email()%' AND lower(pg_get_expr(pa.polqual, pa.polrelid)) NOT LIKE '%select auth.email()%')
         OR (pg_get_expr(pa.polqual, pa.polrelid) LIKE '%current\\_setting(%' AND lower(pg_get_expr(pa.polqual, pa.polrelid)) NOT LIKE '%select current\\_setting(%')
         OR (pg_get_expr(pa.polwithcheck, pa.polrelid) LIKE '%auth.uid()%' AND lower(pg_get_expr(pa.polwithcheck, pa.polrelid)) NOT LIKE '%select auth.uid()%')
         OR (pg_get_expr(pa.polwithcheck, pa.polrelid) LIKE '%auth.jwt()%' AND lower(pg_get_expr(pa.polwithcheck, pa.polrelid)) NOT LIKE '%select auth.jwt()%')
         OR (pg_get_expr(pa.polwithcheck, pa.polrelid) LIKE '%auth.role()%' AND lower(pg_get_expr(pa.polwithcheck, pa.polrelid)) NOT LIKE '%select auth.role()%')
         OR (pg_get_expr(pa.polwithcheck, pa.polrelid) LIKE '%auth.email()%' AND lower(pg_get_expr(pa.polwithcheck, pa.polrelid)) NOT LIKE '%select auth.email()%')
         OR (pg_get_expr(pa.polwithcheck, pa.polrelid) LIKE '%current\\_setting(%' AND lower(pg_get_expr(pa.polwithcheck, pa.polrelid)) NOT LIKE '%select current\\_setting(%')
          );`,
    ),
  );
}

/** cmd + roles + permissive + qual, one line per policy, sorted. */
function policyShape(database: string): string {
  return dockerPsql(
    database,
    `SELECT policyname || ' [' || cmd || ' roles=' || roles::text || ' ' || permissive || '] qual=' || qual
       FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'credit_accounts'
      ORDER BY policyname;`,
  );
}

/** The legacy Suna wallet table with the two policies exactly as prod carries
 *  them: bare `auth.<function>()` calls. The auth stubs stand in for Supabase's
 *  STABLE auth functions, which a plain Postgres container does not ship. */
function legacyFixture(): string {
  return `
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
      AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
    CREATE TABLE public.credit_accounts (
      account_id uuid PRIMARY KEY,
      balance numeric NOT NULL DEFAULT 0
    );
    ALTER TABLE public.credit_accounts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Service role manages credit accounts" ON public.credit_accounts
      USING (auth.role() = 'service_role'::text);
    CREATE POLICY "Users can view own credit account" ON public.credit_accounts
      FOR SELECT USING (auth.uid() = account_id);
  `;
}

function freshDatabase(name: string, fixture: string) {
  dockerPsql('postgres', `DROP DATABASE IF EXISTS ${name};`);
  dockerPsql('postgres', `CREATE DATABASE ${name};`);
  if (fixture) dockerPsql(name, fixture);
}

describe.skipIf(!dockerAvailable)(
  'credit accounts RLS initplan migration — real PostgreSQL',
  () => {
    beforeAll(async () => {
      if (migrationNames.length !== 1) return;
      migration = await Bun.file(resolve(migrationDirectory, migrationNames[0] ?? '')).text();

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
          'postgres:16-alpine',
        ],
        { stdout: 'ignore', stderr: 'ignore' },
      );
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
        if (probe.exitCode === 0) return;
        await Bun.sleep(250);
      }
      throw new Error('Disposable PostgreSQL did not become ready');
    }, 60_000);

    afterAll(() => {
      if (!containerStarted) return;
      Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
    });

    test('rewrites both bare policies and preserves their shape; a second apply is a no-op', () => {
      freshDatabase('legacy_db', legacyFixture());
      // RED, for the stated reason: both policies call auth.<function>() bare,
      // which is exactly what the prod advisor flags.
      expect(advisorFlags('legacy_db')).toBe(2);

      applyMigration('legacy_db');
      expect(advisorFlags('legacy_db')).toBe(0);
      const shape = policyShape('legacy_db');
      expect(shape).toContain(
        'Service role manages credit accounts [ALL roles={public} PERMISSIVE]',
      );
      expect(shape).toContain(
        'Users can view own credit account [SELECT roles={public} PERMISSIVE]',
      );
      // The remediation itself: every auth call sits inside a select subquery.
      // Postgres deparses to `( SELECT auth.role() AS role)` — uppercase, with
      // an alias — so match lowercased, the way the advisor's predicate reads it.
      expect(shape.toLowerCase()).toContain('select auth.role()');
      expect(shape.toLowerCase()).toContain('select auth.uid()');

      applyMigration('legacy_db');
      expect(advisorFlags('legacy_db')).toBe(0);
    }, 60_000);

    test('is a no-op on a database built from the Kortix baseline', () => {
      freshDatabase('baseline_db', '');
      applyMigration('baseline_db');
      expect(
        dockerPsql('baseline_db', "SELECT to_regclass('public.credit_accounts') IS NULL;"),
      ).toBe('t');
    }, 60_000);

    test('rewrites only the policy that exists when the other was already dropped', () => {
      freshDatabase('partial_db', legacyFixture());
      dockerPsql(
        'partial_db',
        'DROP POLICY "Users can view own credit account" ON public.credit_accounts;',
      );
      applyMigration('partial_db');
      expect(advisorFlags('partial_db')).toBe(0);
      expect(
        dockerPsql(
          'partial_db',
          "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='credit_accounts';",
        ),
      ).toBe('1');
    }, 60_000);
  },
);
