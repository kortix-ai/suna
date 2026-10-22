/**
 * The legacy `public` deletion-requests policy wrap, against a real PostgreSQL.
 *
 * The migration recreates the two RLS policies on `public.account_deletion_requests`
 * with their `auth.role()` / `auth.uid()` calls wrapped in `(select ...)`, the
 * Supabase advisor's `auth_rls_initplan` remediation (KRTX-1130). The table only
 * exists on databases that predate the Kortix baseline, so the migration must also
 * be a clean no-op on a fresh database. Nothing here can be asserted without a
 * server: the policy quals live in `pg_policies`, and the fixture has to present
 * the pre-migration (bare-call) shape to prove the wrap.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { dockerAvailable } from './docker-available';

const container = `kortix-wrap-deletion-policies-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_wrap_legacy_public_deletion_policies.sql').scanSync({ cwd: migrationDirectory }),
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
  return output
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('You are now connected'))
    .map((line) => line.trim())
    .join('\n');
}

/** node-pg-migrate runs each file in one transaction; mirror that. */
function applyMigration(database: string) {
  return dockerPsql(database, `BEGIN;\n${migration}\nCOMMIT;\n`);
}

/** The legacy shape prod still carries: RLS on, both policies calling auth.* bare. */
function legacyFixture(): string {
  return `
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'authenticated'::text $$;
    CREATE TABLE public.account_deletion_requests (
        id uuid PRIMARY KEY,
        user_id uuid NOT NULL
    );
    ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "Service role can manage deletion requests" ON public.account_deletion_requests
        USING ((auth.role() = 'service_role'::text));
    CREATE POLICY "Users can view their own deletion requests" ON public.account_deletion_requests
        FOR SELECT USING ((auth.uid() = user_id));
  `;
}

function policies(database: string): string {
  return dockerPsql(
    database,
    `SELECT policyname || ' | ' || cmd || ' | ' || roles::text || ' | ' || qual
       FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'account_deletion_requests'
      ORDER BY policyname`,
  );
}

function freshDatabase(name: string, fixture: string) {
  dockerPsql('postgres', `CREATE DATABASE ${name};`);
  if (fixture) dockerPsql(name, fixture);
}

describe.skipIf(!dockerAvailable)('wrap legacy public deletion policies migration — real PostgreSQL', () => {
  beforeAll(async () => {
    if (migrationNames.length !== 1) return;
    migration = await Bun.file(resolve(migrationDirectory, migrationNames[0]!)).text();

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
    containerStarted = true;

    for (let attempt = 0; attempt < 50; attempt += 1) {
      // TCP, never the unix socket: initdb runs a temporary socket-only
      // server whose readiness says nothing about the real one.
      const probe = Bun.spawnSync(
        ['docker', 'exec', container, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-c', 'SELECT 1'],
        { stdout: 'ignore', stderr: 'ignore' },
      );
      if (probe.exitCode === 0) return;
      await Bun.sleep(250);
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  }, 60_000);

  afterAll(() => {
    if (!containerStarted) return;
    Bun.spawnSync(['docker', 'rm', '-f', '-v', container], { stdout: 'ignore', stderr: 'ignore' });
  });

  test('wraps both policies, preserves cmd/roles/RLS, and a second apply is a no-op', () => {
    freshDatabase('legacy_db', legacyFixture());
    const red = policies('legacy_db');
    expect(red).toContain('| (auth.role() = \'service_role\'::text)');
    expect(red).toContain('| (auth.uid() = user_id)');

    applyMigration('legacy_db');
    const green = policies('legacy_db');
    // Postgres stores the subquery as `( SELECT auth.role() AS role)`.
    expect(green).toContain(
      "Service role can manage deletion requests | ALL | {public} | (( SELECT auth.role() AS role) = 'service_role'::text)",
    );
    expect(green).toContain(
      'Users can view their own deletion requests | SELECT | {public} | (( SELECT auth.uid() AS uid) = user_id)',
    );
    expect(green.split('\n')).toHaveLength(2);
    expect(
      dockerPsql(
        'legacy_db',
        `SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'account_deletion_requests'`,
      ),
    ).toBe('t');

    applyMigration('legacy_db');
    expect(policies('legacy_db')).toBe(green);
  }, 60_000);

  test('is a no-op on a database built from the Kortix baseline', () => {
    freshDatabase('baseline_db', '');
    applyMigration('baseline_db');
    expect(policies('baseline_db')).toBe('');
  }, 60_000);
});
