import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Regression test for the Supabase performance advisor lint
 * `auth_rls_initplan` on `public.agent_runs` (KRTX-1131).
 *
 * `public.agent_runs` is a legacy table from the pre-monorepo database. The
 * baseline never creates it, so on a fresh database the fix migration is a
 * guarded no-op. On the long-lived databases the table carries five RLS
 * policies; `agent_runs_select_policy` calls `auth.uid()` bare, so Postgres
 * re-evaluates it for every row — the finding.
 *
 * The first attempt (merged and reverted, #8821/#8852) hardcoded prod's
 * policy text. It halted every dev deploy: the stored policy qual names bare
 * `threads`/`projects`, and dev's migrate role resolves bare names
 * kortix-first, where `kortix.projects` has no `is_public` (learning
 * 2026-10-03T151842Z). This suite reproduces that exact failure, then proves
 * the committed migration instead:
 *   1. is a guarded no-op on the fresh-install shape,
 *   2. rewrites the policy in place from the stored qual, wrapping only the
 *      `auth.uid()` calls — no legacy column is hardcoded,
 *   3. clears the advisor's own rule (the verbatim 0003 view from
 *      supabase/splinter) and keeps the four sibling policies byte-identical,
 *   4. leaves row visibility unchanged for a member, a non-member and an
 *      admin, evaluated as a real authenticated role,
 *   5. leaves the policy untouched (NOTICE, no error) when the stored qual
 *      cannot be parsed in the migration's search_path,
 *   6. is a no-op on rerun.
 *
 * Fixture DDL runs through TEST_DATABASE_SUPERUSER_URL because the lane role
 * cannot create objects in the public schema; the table then moves to the
 * lane role, which is the role prod's migration runner runs as. The helper
 * tables carry no RLS: the wrap does not touch them, and the visibility
 * comparison runs with identical subquery behavior before and after.
 */

const laneUrl = process.env.TEST_DATABASE_URL;
const superuserUrl = process.env.TEST_DATABASE_SUPERUSER_URL;

if (!laneUrl) throw new Error('TEST_DATABASE_URL is not set');
if (!superuserUrl) throw new Error('TEST_DATABASE_SUPERUSER_URL is not set');

const MIGRATION_GLOB = '*_agent_runs_select_policy_initplan.sql';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_ADMIN = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** The advisor's own lint, verbatim from supabase/splinter
 *  (lints/0003_auth_rls_initplan.sql, Apache-2.0). Running the vendor rule —
 *  not a re-derivation — is what makes the red and green assertions the
 *  acceptance criterion itself. */
const ADVISOR_LINT_VIEW = `
  create schema if not exists lint;
  create or replace view lint."0003_auth_rls_initplan" as
  with policies as (
      select
          nsp.nspname as schema_name,
          pb.tablename as table_name,
          pc.relrowsecurity as is_rls_active,
          polname as policy_name,
          polpermissive as is_permissive,
          (select array_agg(r::regrole) from unnest(polroles) as x(r)) as roles,
          case polcmd
              when 'r' then 'SELECT'
              when 'a' then 'INSERT'
              when 'w' then 'UPDATE'
              when 'd' then 'DELETE'
              when '*' then 'ALL'
          end as command,
          qual,
          with_check
      from
          pg_catalog.pg_policy pa
          join pg_catalog.pg_class pc
              on pa.polrelid = pc.oid
          join pg_catalog.pg_namespace nsp
              on pc.relnamespace = nsp.oid
          join pg_catalog.pg_policies pb
              on pc.relname = pb.tablename
              and nsp.nspname = pb.schemaname
              and pa.polname = pb.policyname
  )
  select
      'auth_rls_initplan' as name,
      'Auth RLS Initialization Plan' as title,
      'WARN' as level,
      'EXTERNAL' as facing,
      array['PERFORMANCE'] as categories,
      'Detects if calls to current_setting() and auth.<function>() in RLS policies are being unnecessarily re-evaluated for each row' as description,
      format(
          'Table %s.%s has a row level security policy %s that re-evaluates current_setting() or auth.<function>() for each row.',
          schema_name,
          table_name,
          policy_name
      ) as detail,
      'https://supabase.com/docs/guides/database/database-linter?lint=0003_auth_rls_initplan' as remediation,
      jsonb_build_object(
          'schema', schema_name,
          'name', table_name,
          'type', 'table'
      ) as metadata,
      format('auth_rls_init_plan_%s_%s_%s', schema_name, table_name, policy_name) as cache_key
  from
      policies
  where
      is_rls_active
      and schema_name not in (
          '_timescaledb_cache', '_timescaledb_catalog', '_timescaledb_config', '_timescaledb_internal', 'auth', 'cron', 'extensions', 'graphql', 'graphql_public', 'information_schema', 'net', 'pgmq', 'pgroonga', 'pgsodium', 'pgsodium_masks', 'pgtle', 'pgbouncer', 'pg_catalog', 'repack', 'storage', 'supabase_functions', 'supabase_migrations', 'tiger', 'topology', 'vault'
      )
      and (
          (
              qual like '%auth.uid()%'
              and lower(qual) not like '%select auth.uid()%'
          )
          or (
              qual like '%auth.jwt()%'
              and lower(qual) not like '%select auth.jwt()%'
          )
          or (
              qual like '%auth.role()%'
              and lower(qual) not like '%select auth.role()%'
          )
          or (
              qual like '%auth.email()%'
              and lower(qual) not like '%select auth.email()%'
          )
          or (
              qual like '%current\_setting(%)%'
              and lower(qual) not like '%select current\_setting(%)%'
          )
          or (
              with_check like '%auth.uid()%'
              and lower(with_check) not like '%select auth.uid()%'
          )
          or (
              with_check like '%auth.jwt()%'
              and lower(with_check) not like '%select auth.jwt()%'
          )
          or (
              with_check like '%auth.role()%'
              and lower(with_check) not like '%select auth.role()%'
          )
          or (
              with_check like '%auth.email()%'
              and lower(with_check) not like '%select auth.email()%'
          )
          or (
              with_check like '%current\_setting(%)%'
              and lower(with_check) not like '%select current\_setting(%)%'
          )
      )
;`;

/** The legacy prod state, transcribed 1:1 from pg_policies on the prod
 *  project (2026-10-04, read-only Management API): the five policies of
 *  public.agent_runs with their stored quals, and the public objects those
 *  quals name. The helpers are non-clobbering: a migrated lane database
 *  already has auth.uid(), the Supabase roles and basejump.account_user from
 *  scripts/test-prereqs.sql, and an existing basejump.has_role_on_account is
 *  never replaced. */
const LEGACY_FIXTURE = `
  ${ADVISOR_LINT_VIEW}

  do $bj$ begin
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'basejump' and p.proname = 'has_role_on_account'
        and pg_get_function_identity_arguments(p.oid) = 'account_id uuid, account_role basejump.account_role'
    ) then
      create function basejump.has_role_on_account(account_id uuid, account_role basejump.account_role default null)
        returns boolean language sql security definer set search_path to 'public'
        as 'select exists(
              select 1 from basejump.account_user wu
              where wu.user_id = auth.uid()
                and wu.account_id = has_role_on_account.account_id
                and (wu.account_role = has_role_on_account.account_role or has_role_on_account.account_role is null)
            )';
    end if;
  end $bj$;

  do $ur$ begin
    if not exists (
      select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typname = 'user_role'
    ) then
      create type public.user_role as enum ('user', 'admin', 'super_admin');
    end if;
  end $ur$;

  create table if not exists public.user_roles (
    user_id uuid not null,
    role public.user_role not null
  );

  create table if not exists public.projects (
    project_id uuid primary key,
    account_id uuid not null,
    is_public boolean not null default false
  );

  create table if not exists public.threads (
    thread_id uuid primary key,
    project_id uuid,
    account_id uuid not null,
    is_public boolean not null default false
  );

  create table if not exists public.agent_runs (
    id uuid primary key default gen_random_uuid(),
    thread_id uuid not null
  );
  alter table public.agent_runs enable row level security;

  -- A helper resolvable only outside the migration's own search_path, for the
  -- unparseable-qual test below.
  create schema if not exists agent_runs_probe;
  create table if not exists agent_runs_probe.helper (account_id uuid primary key);

  drop policy if exists agent_run_delete_policy on public.agent_runs;
  drop policy if exists agent_run_insert_policy on public.agent_runs;
  drop policy if exists agent_run_select_policy on public.agent_runs;
  drop policy if exists agent_run_update_policy on public.agent_runs;
  drop policy if exists agent_runs_select_policy on public.agent_runs;

  create policy agent_run_delete_policy on public.agent_runs
    as permissive for delete to public
    using (
      EXISTS ( SELECT 1
       FROM (threads
         LEFT JOIN projects ON ((threads.project_id = projects.project_id)))
      WHERE ((threads.thread_id = agent_runs.thread_id) AND ((basejump.has_role_on_account(threads.account_id) = true) OR (basejump.has_role_on_account(projects.account_id) = true))))
    );

  create policy agent_run_insert_policy on public.agent_runs
    as permissive for insert to public
    with check (
      EXISTS ( SELECT 1
       FROM (threads
         LEFT JOIN projects ON ((threads.project_id = projects.project_id)))
      WHERE ((threads.thread_id = agent_runs.thread_id) AND ((basejump.has_role_on_account(threads.account_id) = true) OR (basejump.has_role_on_account(projects.account_id) = true))))
    );

  create policy agent_run_select_policy on public.agent_runs
    as permissive for select to public
    using (
      EXISTS ( SELECT 1
       FROM (threads
         LEFT JOIN projects ON ((threads.project_id = projects.project_id)))
      WHERE ((threads.thread_id = agent_runs.thread_id) AND ((projects.is_public = true) OR (basejump.has_role_on_account(threads.account_id) = true) OR (basejump.has_role_on_account(projects.account_id) = true))))
    );

  create policy agent_run_update_policy on public.agent_runs
    as permissive for update to public
    using (
      EXISTS ( SELECT 1
       FROM (threads
         LEFT JOIN projects ON ((threads.project_id = projects.project_id)))
      WHERE ((threads.thread_id = agent_runs.thread_id) AND ((basejump.has_role_on_account(threads.account_id) = true) OR (basejump.has_role_on_account(projects.account_id) = true))))
    );

  create policy agent_runs_select_policy on public.agent_runs
    as permissive for select to public
    using (
      ((EXISTS ( SELECT 1
         FROM threads
        WHERE ((threads.thread_id = agent_runs.thread_id) AND ((threads.is_public = true) OR (threads.account_id = auth.uid()) OR (basejump.has_role_on_account(threads.account_id) = true) OR (EXISTS ( SELECT 1
                 FROM projects
                WHERE ((projects.project_id = threads.project_id) AND ((projects.is_public = true) OR (basejump.has_role_on_account(projects.account_id) = true)))))))))
       OR (EXISTS ( SELECT 1
         FROM user_roles
        WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))))
    )
`;

/** The prod policy names, in pg_policies order. The last one is the finding;
 *  the other four must come out byte-identical. */
const LEGACY_POLICIES = [
  'agent_run_delete_policy',
  'agent_run_insert_policy',
  'agent_run_select_policy',
  'agent_run_update_policy',
  'agent_runs_select_policy',
];

/** Threads and runs the fixture seeds: one public thread and one private
 *  thread per account; the admin user is a member of no account. */
const THREAD_PUBLIC_B = 'c0000000-0000-4000-8000-000000000001';
const THREAD_PRIVATE_A = 'c0000000-0000-4000-8000-000000000002';
const THREAD_PRIVATE_B = 'c0000000-0000-4000-8000-000000000003';
const PROJECT_A = 'd0000000-0000-4000-8000-000000000001';
const PROJECT_B = 'd0000000-0000-4000-8000-000000000002';
const PROJECT_PUBLIC_B = 'd0000000-0000-4000-8000-000000000003';

let migrationSql: string;
let laneRole: string;

/** Expected agent_runs rows visible per fixture user: the public thread, the
 *  own private thread, and — via the admin branch — everything. */
const EXPECTED_VISIBLE: Record<string, number> = {
  [USER_A]: 2,
  [USER_B]: 2,
  [USER_ADMIN]: 3,
};

/** The PostgreSQL error code of a driver error, or undefined. Same shape as migration-retry.ts. */
function pgErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown };
  return typeof value.code === 'string' ? value.code : undefined;
}

async function withClient(url: string, fn: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

interface PolicyRow {
  policyname: string;
  permissive: string;
  roles: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
}

async function readPolicies(client: pg.Client): Promise<PolicyRow[]> {
  const { rows } = await client.query<PolicyRow>(
    `SELECT policyname, permissive::text, roles::text, cmd, qual, with_check
     FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'agent_runs'
     ORDER BY policyname`,
  );
  return rows;
}

/** The exact advisor finding on public.agent_runs, or no row when clear.
 *  The splinter view exposes the table in metadata and the identity in
 *  cache_key; it has no policy_name column of its own. */
async function advisorFinding(client: pg.Client) {
  const { rows } = await client.query<{ cache_key: string }>(
    `SELECT cache_key FROM lint."0003_auth_rls_initplan"
     WHERE metadata->>'schema' = 'public' AND metadata->>'name' = 'agent_runs'`,
  );
  return rows;
}

/** agent_runs rows visible to one fixture user, as a real authenticated role. */
async function visibleRunsAs(client: pg.Client, user: string): Promise<number> {
  await client.query('BEGIN');
  await client.query(`SET LOCAL request.jwt.claim.sub = '${user}'`);
  await client.query('SET LOCAL ROLE authenticated');
  const { rows } = await client.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM public.agent_runs',
  );
  await client.query('ROLLBACK');
  return Number(rows[0]?.n ?? 0);
}

/** node-pg-migrate runs each file in one transaction; mirror that. */
function applyMigration(client: pg.Client, migration: string) {
  return client.query(`begin;\n${migration}\ncommit;`);
}

describe('agent_runs select policy auth_rls_initplan migration', () => {
  beforeAll(async () => {
    const migrationNames = Array.from(
      new Bun.Glob(MIGRATION_GLOB).scanSync({ cwd: join(import.meta.dir, '..', 'migrations') }),
    );
    expect(migrationNames).toHaveLength(1);
    migrationSql = readFileSync(
      join(import.meta.dir, '..', 'migrations', migrationNames[0]),
      'utf8',
    );
    await withClient(laneUrl, async (client) => {
      const who = await client.query<{ role: string }>('SELECT current_user AS role');
      laneRole = who.rows[0].role;
    });
  });

  afterAll(async () => {
    // Per-file lane database: drop exactly what the fixture created.
    await withClient(superuserUrl, async (admin) => {
      await admin.query('DROP TABLE IF EXISTS public.agent_runs CASCADE');
      await admin.query('DROP TABLE IF EXISTS public.threads CASCADE');
      await admin.query('DROP TABLE IF EXISTS public.projects CASCADE');
      await admin.query('DROP TABLE IF EXISTS public.user_roles CASCADE');
      await admin.query('DROP SCHEMA IF EXISTS agent_runs_probe CASCADE');
      await admin.query('DROP TYPE IF EXISTS public.user_role CASCADE');
      await admin.query('DROP SCHEMA IF EXISTS lint CASCADE');
    });
  });

  test('fresh-install shape: the migration is a guarded no-op (no legacy table)', async () => {
    await withClient(laneUrl, async (client) => {
      // The lane database is a fresh install shape: the legacy table must not
      // pre-exist, or this suite would be testing a state prod is not in.
      const preexisting = await client.query(
        `SELECT to_regclass('public.agent_runs') IS NOT NULL AS present`,
      );
      expect(preexisting.rows[0].present).toBe(false);

      await client.query(migrationSql);
      const created = await client.query(
        `SELECT to_regclass('public.agent_runs') IS NOT NULL AS present`,
      );
      expect(created.rows[0].present).toBe(false);
      const policies = await client.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_runs'`,
      );
      expect(policies.rowCount).toBe(0);
    });
  });

  describe('with the legacy prod state present', () => {
    let visibilityBefore: Record<string, number>;
    let policiesBefore: PolicyRow[];

    beforeAll(async () => {
      await withClient(superuserUrl, async (admin) => {
        await admin.query(LEGACY_FIXTURE);
        // The legacy policy's subqueries read threads/projects/user_roles and
        // call auth.uid() as the querying role, exactly as they do for an
        // authenticated client. The lane's superuser-created helpers carry no
        // grants, so mirror prod's grant shape here.
        await admin.query('GRANT USAGE ON SCHEMA basejump TO PUBLIC');
        await admin.query('GRANT USAGE ON SCHEMA public TO PUBLIC');
        await admin.query('GRANT USAGE ON SCHEMA agent_runs_probe TO PUBLIC');
        await admin.query(`GRANT SELECT ON public.threads, public.projects, public.user_roles TO PUBLIC`);
        await admin.query(`ALTER TABLE public.agent_runs OWNER TO ${laneRole}`);
        await admin.query(`GRANT SELECT ON public.agent_runs TO authenticated`);
        // Superuser inserts bypass RLS; prod's rows were written by its API role.
        await admin.query(
          `INSERT INTO basejump.account_user (user_id, account_id, account_role)
           VALUES ($1, $2, 'owner'), ($3, $4, 'owner')`,
          [USER_A, ACCOUNT_A, USER_B, ACCOUNT_B],
        );
        await admin.query(
          `INSERT INTO public.projects (project_id, account_id, is_public)
           VALUES ($1, $2, false), ($3, $4, false), ($5, $4, true)`,
          [PROJECT_A, ACCOUNT_A, PROJECT_B, ACCOUNT_B, PROJECT_PUBLIC_B],
        );
        await admin.query(
          `INSERT INTO public.threads (thread_id, project_id, account_id, is_public)
           VALUES ($1, $2, $3, false), ($4, $5, $6, false), ($7, $8, $6, true)`,
          [THREAD_PRIVATE_A, PROJECT_A, ACCOUNT_A, THREAD_PRIVATE_B, PROJECT_B, ACCOUNT_B, THREAD_PUBLIC_B, PROJECT_PUBLIC_B],
        );
        await admin.query(
          `INSERT INTO public.agent_runs (thread_id)
           VALUES ($1), ($2), ($3)`,
          [THREAD_PUBLIC_B, THREAD_PRIVATE_A, THREAD_PRIVATE_B],
        );
        await admin.query(
          `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'admin')`,
          [USER_ADMIN],
        );
      });

      await withClient(laneUrl, async (client) => {
        policiesBefore = await readPolicies(client);
        visibilityBefore = {};
        for (const user of Object.keys(EXPECTED_VISIBLE)) {
          visibilityBefore[user] = await visibleRunsAs(client, user);
        }
      });
    });

    test('the fixture seeds the prod state the advisor flags', async () => {
      await withClient(laneUrl, async (client) => {
        const policies = await readPolicies(client);
        expect(policies.map((row) => row.policyname)).toEqual(LEGACY_POLICIES);
        expect(policiesBefore).toHaveLength(LEGACY_POLICIES.length);
        // The wrap must not be reachable through the fixture by accident.
        expect(policiesBefore.find((row) => row.policyname === 'agent_runs_select_policy')?.qual).toContain('auth.uid()');
        expect(policiesBefore.find((row) => row.policyname === 'agent_runs_select_policy')?.qual).not.toContain('select auth.uid()');
      });
    });

    test('red: the advisor flags the prod finding before the migration', async () => {
      await withClient(laneUrl, async (client) => {
        const findings = await advisorFinding(client);
        expect(findings).toHaveLength(1);
        expect(findings[0].cache_key).toBe(
          'auth_rls_init_plan_public_agent_runs_agent_runs_select_policy',
        );
      });
    });

    test('red: the hardcoded unqualified rewrite fails under dev search_path (the reverted #8821 incident)', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query('BEGIN');
        await client.query(`SET LOCAL search_path = kortix, public, extensions`);
        let code: string | undefined;
        let message = '';
        try {
          // The reverted first attempt: prod's policy text, bare table names.
          await client.query(`DROP POLICY agent_runs_select_policy ON public.agent_runs`);
          await client.query(`CREATE POLICY agent_runs_select_policy ON public.agent_runs
            AS PERMISSIVE FOR SELECT TO public
            USING (
              EXISTS ( SELECT 1 FROM threads
                WHERE ((threads.thread_id = agent_runs.thread_id) AND ((threads.is_public = true) OR (threads.account_id = auth.uid()) OR (basejump.has_role_on_account(threads.account_id) = true) OR (EXISTS ( SELECT 1 FROM projects
                  WHERE ((projects.project_id = threads.project_id) AND ((projects.is_public = true) OR (basejump.has_role_on_account(projects.account_id) = true))))))))
              OR (EXISTS ( SELECT 1 FROM user_roles
                WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role])))))
            )`);
        } catch (error) {
          code = pgErrorCode(error);
          message = error instanceof Error ? error.message : String(error);
        }
        await client.query('ROLLBACK');
        expect(code).toBe('42703');
        expect(message).toContain('is_public');
        expect(message).toContain('does not exist');
        // The rollback left the working policy in place.
        const after = await readPolicies(client);
        expect(after.find((row) => row.policyname === 'agent_runs_select_policy')?.qual).toEqual(
          policiesBefore.find((row) => row.policyname === 'agent_runs_select_policy')?.qual ?? null,
        );
      });
    });

    test('the migration wraps auth.uid() in place and preserves the stored predicates', async () => {
      await withClient(laneUrl, async (client) => {
        const pathBefore = await client.query<{ value: string }>("SELECT current_setting('search_path') AS value");
        await applyMigration(client, migrationSql);
        const pathAfter = await client.query<{ value: string }>("SELECT current_setting('search_path') AS value");
        expect(pathAfter.rows[0].value).toBe(pathBefore.rows[0].value);

        const findings = await advisorFinding(client);
        expect(findings).toHaveLength(0);

        const target = (await readPolicies(client)).find(
          (row) => row.policyname === 'agent_runs_select_policy',
        );
        expect(target).toBeDefined();
        const qual = target!.qual ?? '';
        // Both auth.uid() calls are wrapped now, and nothing else moved.
        expect(qual.toLowerCase().split('select auth.uid()').length - 1).toBe(2);
        expect(qual).toContain('threads.is_public');
        expect(qual).toContain('projects.is_public');
        expect(qual).toContain('basejump.has_role_on_account');
        expect(qual).toContain('user_roles');
        expect(target!.permissive).toBe('PERMISSIVE');
        expect(target!.cmd).toBe('SELECT');
        expect(target!.roles).toBe('{public}');
        expect(target!.with_check).toBeNull();

        // Scope: the four sibling policies are byte-identical.
        const after = await readPolicies(client);
        for (const sibling of LEGACY_POLICIES.filter((name) => name !== 'agent_runs_select_policy')) {
          const before = policiesBefore.find((row) => row.policyname === sibling);
          const current = after.find((row) => row.policyname === sibling);
          expect(current).toEqual(before);
        }
      });
    });

    test('row visibility is unchanged for a member, a non-member and an admin', async () => {
      await withClient(laneUrl, async (client) => {
        for (const [user, expected] of Object.entries(EXPECTED_VISIBLE)) {
          expect(visibilityBefore[user]).toBe(expected);
          expect(await visibleRunsAs(client, user)).toBe(expected);
        }
      });
    });

    test('rerun is a no-op', async () => {
      await withClient(laneUrl, async (client) => {
        const before = (await readPolicies(client)).find(
          (row) => row.policyname === 'agent_runs_select_policy',
        );
        await applyMigration(client, migrationSql);
        const after = (await readPolicies(client)).find(
          (row) => row.policyname === 'agent_runs_select_policy',
        );
        expect(after).toEqual(before);
        expect(await advisorFinding(client)).toHaveLength(0);
      });
    });

    test('an unparseable stored qual is skipped with a NOTICE, not an error', async () => {
      await withClient(laneUrl, async (client) => {
        // A policy whose qual resolves only outside the migration's own
        // search_path: create it while the helper schema (fixture-created,
        // USAGE granted to PUBLIC) is on the path, then run the migration,
        // whose parse runs public-first.
        await client.query('BEGIN');
        await client.query(`DROP POLICY agent_runs_select_policy ON public.agent_runs`);
        await client.query(`SET LOCAL search_path = public, agent_runs_probe`);
        await client.query(`CREATE POLICY agent_runs_select_policy ON public.agent_runs
          AS PERMISSIVE FOR SELECT TO public
          USING (EXISTS (SELECT 1 FROM helper WHERE helper.account_id = auth.uid()))`);
        await client.query('COMMIT');

        // The migration must not fail: the NOTICE branch keeps the policy.
        await applyMigration(client, migrationSql);
        const probe = (await readPolicies(client)).find(
          (row) => row.policyname === 'agent_runs_select_policy',
        );
        expect(probe?.qual).toContain('helper');
        expect(probe?.qual).not.toContain('select auth.uid()');

        // Restore the prod policy bare, then re-run the migration, so the
        // suite leaves the same wrapped state the fix test produced.
        await client.query('BEGIN');
        await client.query(`DROP POLICY agent_runs_select_policy ON public.agent_runs`);
        await client.query(`CREATE POLICY agent_runs_select_policy ON public.agent_runs
          AS PERMISSIVE FOR SELECT TO public
          USING (
            ((EXISTS ( SELECT 1
               FROM threads
              WHERE ((threads.thread_id = agent_runs.thread_id) AND ((threads.is_public = true) OR (threads.account_id = auth.uid()) OR (basejump.has_role_on_account(threads.account_id) = true) OR (EXISTS ( SELECT 1
                       FROM projects
                      WHERE ((projects.project_id = threads.project_id) AND ((projects.is_public = true) OR (basejump.has_role_on_account(projects.account_id) = true)))))))))
             OR (EXISTS ( SELECT 1
               FROM user_roles
              WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::user_role, 'super_admin'::user_role]))))))
          )`);
        await client.query('COMMIT');
        await applyMigration(client, migrationSql);
        expect(await advisorFinding(client)).toHaveLength(0);
      });
    });
  });
});
