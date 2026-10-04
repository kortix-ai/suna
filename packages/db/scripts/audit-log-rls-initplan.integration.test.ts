/**
 * The `auth_rls_initplan` fix for the legacy `public.audit_log`, against a
 * real PostgreSQL.
 *
 * The Supabase performance advisor flags RLS policies that call
 * `auth.<function>()` bare: the call is re-evaluated for every filtered row.
 * The remediation wraps each call in a scalar subquery so the planner builds
 * an InitPlan and evaluates it once per statement. This test pins the
 * migration's contracts: the advisor's own predicate stops flagging the table,
 * the policies keep their roles/command/permissiveness (ALTER POLICY, not a
 * recreate), row visibility is unchanged, the per-row evaluation becomes a
 * once-per-statement InitPlan, and the migration is a no-op everywhere the
 * legacy table or a policy is absent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { dockerAvailable } from './docker-available';

const container = `kortix-audit-rls-${crypto.randomUUID().slice(0, 8)}`;
const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_audit_log_rls_initplan.sql').scanSync({ cwd: migrationDirectory }),
);
let containerStarted = false;
let migration = '';

// Prod `public.audit_log` (information_schema, read-only Management API):
// id, account_id, category, action, details, ip_address, user_agent, created_at.
const LEGACY_TABLE = `
  CREATE TABLE public.audit_log (
    id uuid NOT NULL,
    account_id uuid NOT NULL,
    category varchar NOT NULL,
    action varchar NOT NULL,
    details jsonb,
    ip_address varchar,
    user_agent text,
    created_at timestamptz
  );
  ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
`;

// Prod pg_policies verbatim (read-only Management API, 2026-10-04): both
// permissive, roles {public}, bare auth.<function>() calls, with_check NULL.
const LEGACY_POLICIES = `
  CREATE POLICY "Service role manages audit log" ON public.audit_log
    USING (auth.role() = 'service_role'::text);
  CREATE POLICY "Users can view own audit log" ON public.audit_log
    FOR SELECT USING (auth.uid() = account_id);
`;

const OWNER_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const OWNER_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const OWNER_C = 'cccccccc-0000-0000-0000-000000000003';

// STABLE stand-ins for Supabase's auth functions, keyed off the same GUCs the
// prod policies authorize by (a plain Postgres container ships neither).
const FUNCTIONAL_AUTH = `
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
    AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
`;

// Counting stand-ins: the same stubs plus a call counter per function, to
// prove the per-row → once-per-statement change the lint is about.
const COUNTING_AUTH = `
  CREATE SCHEMA auth;
  CREATE SEQUENCE public.auth_uid_calls;
  CREATE SEQUENCE public.auth_role_calls;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
  BEGIN
    PERFORM nextval('public.auth_uid_calls');
    RETURN NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
  END $$;
  CREATE FUNCTION auth.role() RETURNS text LANGUAGE plpgsql STABLE AS $$
  BEGIN
    PERFORM nextval('public.auth_role_calls');
    RETURN coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon');
  END $$;
`;

// Roles are cluster-level: the probe role is created once per container
// (beforeAll), the per-database grants live here.
const PROBE_ROLE = `
  GRANT USAGE ON SCHEMA public, auth TO audit_probe;
  GRANT SELECT ON public.audit_log TO audit_probe;
`;

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
      // -q drops command tags (SET, BEGIN, CREATE ...) so a multi-statement
      // script that ends in a SELECT returns only that SELECT's rows.
      '-q',
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
          AND nsp.nspname = 'public' AND pc.relname = 'audit_log'
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

/** cmd + roles + permissive + with_check + qual, one line per policy, sorted. */
function policyShape(database: string): string {
  return dockerPsql(
    database,
    `SELECT policyname || ' [' || cmd || ' roles=' || roles::text || ' ' || permissive
              || ' wc=' || coalesce(with_check::text, 'null') || '] qual=' || qual
       FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'audit_log'
      ORDER BY policyname;`,
  );
}

/** Rows `audit_probe` sees, as one deterministic string per probe identity. */
function visibleRows(database: string, sub: string, role: string): string {
  return dockerPsql(
    database,
    `SET ROLE audit_probe;
     SET request.jwt.claim.sub = '${sub}';
     SET request.jwt.claim.role = '${role}';
     SELECT coalesce(string_agg(category || ':' || action, ',' ORDER BY id), '')
       FROM public.audit_log;`,
  );
}

/** Reset both call counters, then return `uid|role` calls of one probe SELECT. */
function authCallCounts(database: string): string {
  dockerPsql(
    database,
    "SELECT setval('public.auth_uid_calls', 1, true), setval('public.auth_role_calls', 1, true);",
  );
  dockerPsql(
    database,
    `SET ROLE audit_probe;
     SET request.jwt.claim.sub = '${OWNER_C}';
     SET request.jwt.claim.role = 'authenticated';
     SELECT count(*) FROM public.audit_log;`,
  );
  return dockerPsql(
    database,
    "SELECT ((SELECT last_value FROM public.auth_uid_calls) - 1) || '|' || ((SELECT last_value FROM public.auth_role_calls) - 1);",
  );
}

/** The EXPLAIN plan of the same probe SELECT (InitPlan is the fix's signature). */
function probePlan(database: string): string {
  return dockerPsql(
    database,
    `SET ROLE audit_probe;
     SET request.jwt.claim.sub = '${OWNER_C}';
     SET request.jwt.claim.role = 'authenticated';
     EXPLAIN (COSTS OFF) SELECT count(*) FROM public.audit_log;`,
  );
}

function freshDatabase(name: string, fixture: string) {
  dockerPsql('postgres', `DROP DATABASE IF EXISTS ${name};`);
  dockerPsql('postgres', `CREATE DATABASE ${name};`);
  if (fixture) dockerPsql(name, fixture);
}

const SEED_ROWS = ` INSERT INTO public.audit_log (id, account_id, category, action) VALUES
  ('00000000-0000-0000-0000-000000000001', '${OWNER_A}', 'auth', 'signin'),
  ('00000000-0000-0000-0000-000000000002', '${OWNER_A}', 'data', 'export'),
  ('00000000-0000-0000-0000-000000000003', '${OWNER_B}', 'auth', 'signin');
`;

// The legacy SELECT policy is `auth.uid() = account_id`: on this legacy table
// the row's account_id carries the user's own uuid.
const SEEDED_DB = `
  ${FUNCTIONAL_AUTH}
  ${LEGACY_TABLE}
  ${LEGACY_POLICIES}
  ${PROBE_ROLE}
  ${SEED_ROWS}
`;

const COUNTED_DB = `
  ${COUNTING_AUTH}
  ${LEGACY_TABLE}
  ${LEGACY_POLICIES}
  ${PROBE_ROLE}
  GRANT USAGE, SELECT ON SEQUENCE public.auth_uid_calls, public.auth_role_calls TO audit_probe;
  ${SEED_ROWS}
`;

describe.skipIf(!dockerAvailable)('audit_log RLS initplan migration — real PostgreSQL', () => {
  beforeAll(async () => {
    if (migrationNames.length > 1) {
      throw new Error(`expected one audit_log initplan migration, got ${migrationNames.length}`);
    }
    migration =
      migrationNames.length === 1
        ? await Bun.file(resolve(migrationDirectory, migrationNames[0])).text()
        : '';

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
      if (probe.exitCode === 0) {
        // Roles are cluster-level: create the probe role once, now that the
        // server is ready.
        dockerPsql('postgres', 'CREATE ROLE audit_probe NOLOGIN;');
        return;
      }
      await Bun.sleep(250);
    }
    throw new Error('Disposable PostgreSQL did not become ready');
  }, 60_000);

  afterAll(() => {
    if (!containerStarted) return;
    Bun.spawnSync(['docker', 'rm', '-f', container], { stdout: 'ignore', stderr: 'ignore' });
  }, 30_000);

  test('rewrites both bare policies and preserves their shape; a second apply is a no-op', () => {
    freshDatabase('legacy_db', FUNCTIONAL_AUTH + LEGACY_TABLE + LEGACY_POLICIES);
    // RED, for the stated reason: both policies call auth.<function>() bare,
    // which is exactly what the prod advisor flags.
    expect(advisorFlags('legacy_db')).toBe(2);
    // The fixture mirrors prod verbatim.
    expect(policyShape('legacy_db')).toBe(
      [
        "Service role manages audit log [ALL roles={public} PERMISSIVE wc=null] qual=(auth.role() = 'service_role'::text)",
        'Users can view own audit log [SELECT roles={public} PERMISSIVE wc=null] qual=(auth.uid() = account_id)',
      ].join('\n'),
    );

    applyMigration('legacy_db');
    expect(advisorFlags('legacy_db')).toBe(0);
    const shape = policyShape('legacy_db');
    expect(shape).toContain(
      'Service role manages audit log [ALL roles={public} PERMISSIVE wc=null]',
    );
    expect(shape).toContain(
      'Users can view own audit log [SELECT roles={public} PERMISSIVE wc=null]',
    );
    // The remediation itself: every auth call sits inside a select subquery.
    // Postgres deparses to `( SELECT auth.role() AS role)` — uppercase, with
    // an alias — so match lowercased, the way the advisor's predicate reads it.
    expect(shape.toLowerCase()).toContain('select auth.role()');
    expect(shape.toLowerCase()).toContain('select auth.uid()');

    applyMigration('legacy_db');
    expect(advisorFlags('legacy_db')).toBe(0);
  }, 60_000);

  test('row visibility is unchanged: per-user rows, service-role all, anon none', () => {
    freshDatabase('visible_db', SEEDED_DB);
    const before = {
      ownerA: visibleRows('visible_db', OWNER_A, 'authenticated'),
      ownerB: visibleRows('visible_db', OWNER_B, 'authenticated'),
      serviceRole: visibleRows('visible_db', '', 'service_role'),
      anon: visibleRows('visible_db', '', 'anon'),
    };
    expect(before).toEqual({
      ownerA: 'auth:signin,data:export',
      ownerB: 'auth:signin',
      serviceRole: 'auth:signin,data:export,auth:signin',
      anon: '',
    });

    applyMigration('visible_db');
    expect(visibleRows('visible_db', OWNER_A, 'authenticated')).toBe(before.ownerA);
    expect(visibleRows('visible_db', OWNER_B, 'authenticated')).toBe(before.ownerB);
    expect(visibleRows('visible_db', '', 'service_role')).toBe(before.serviceRole);
    expect(visibleRows('visible_db', '', 'anon')).toBe(before.anon);
  }, 60_000);

  test('evaluates each auth call once per statement instead of per row (InitPlan)', () => {
    freshDatabase('counted_db', COUNTED_DB);
    // RED, for the stated reason: the bare calls are evaluated once at
    // planning plus once per scanned row (3 rows, probe owns none: 4 and 3
    // calls; measured on postgres:16 — the planner itself evaluates the
    // bare qual once, then the executor once per row). The counting stubs
    // stand in for Supabase's auth.uid()/auth.role(); the probe (OWNER_C)
    // owns no rows, so the count is 0 both before and after.
    expect(authCallCounts('counted_db')).toBe('4|3');
    const planBefore = probePlan('counted_db');
    expect(planBefore).toContain('auth.uid()');
    expect(planBefore).not.toContain('InitPlan');

    applyMigration('counted_db');
    // GREEN: the wrapped calls are InitPlans — planned once, evaluated once
    // per statement, whatever the row count.
    expect(authCallCounts('counted_db')).toBe('1|1');
    expect(probePlan('counted_db')).toContain('InitPlan');
  }, 60_000);

  test('is a no-op on a database built from the Kortix baseline', () => {
    freshDatabase('baseline_db', '');
    applyMigration('baseline_db');
    expect(dockerPsql('baseline_db', "SELECT to_regclass('public.audit_log') IS NULL;")).toBe('t');
  }, 60_000);

  test('rewrites only the policy that exists when the other was already dropped', () => {
    freshDatabase('partial_db', FUNCTIONAL_AUTH + LEGACY_TABLE + LEGACY_POLICIES);
    dockerPsql('partial_db', 'DROP POLICY "Users can view own audit log" ON public.audit_log;');
    applyMigration('partial_db');
    expect(advisorFlags('partial_db')).toBe(0);
    expect(
      dockerPsql(
        'partial_db',
        "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='audit_log';",
      ),
    ).toBe('1');
  }, 60_000);
});
