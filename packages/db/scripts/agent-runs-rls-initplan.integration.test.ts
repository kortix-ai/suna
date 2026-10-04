/**
 * The `agent_runs` RLS auth-initplan wrap, against a real PostgreSQL.
 *
 * KRTX-1131: the Supabase advisor (lint `auth_rls_initplan`) flags
 * `agent_runs_select_policy` on the legacy `public.agent_runs` — its
 * expressions call `auth.uid()` bare, so Postgres re-evaluates the call for
 * every scanned row. The migration rewrites every policy on the table IN
 * PLACE from its own stored expression (`ALTER POLICY` with the stored qual,
 * bare auth calls wrapped), so it needs no column name and preserves each
 * environment's own predicate. That is the property the earlier DROP+CREATE
 * rewrite of this policy lacked: it transcribed prod's text, including
 * `projects.is_public` — a column dev does not have — and halted every dev
 * deploy at the apply (#8852).
 *
 * Four things are worth a real database: the plan changes from a per-row
 * filter call to a one-per-statement InitPlan while row visibility stays
 * identical; the rewrite is content-driven, so a policy whose expression has
 * no bare auth call (the four siblings) is untouched; the apply succeeds
 * under dev's migrate-role search_path (`kortix, public, extensions`), where
 * re-parsing a stored expression with bare names would otherwise bind
 * kortix.*; and re-applying is a no-op.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';
import { unqualify } from './verify-live-schema';

const databaseUrl = process.env.TEST_DATABASE_URL;
// Fixture setup and the RLS probe need a session that may create roles and
// SET ROLE to a NOBYPASSRLS role: the db-suites lane passes its superuser URL
// beside TEST_DATABASE_URL for exactly that kind of work.
const setupUrl = process.env.TEST_DATABASE_SUPERUSER_URL ?? databaseUrl;

const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_agent_runs_rls_auth_initplan.sql').scanSync({ cwd: migrationDirectory }),
);

const TABLE = 'public.agent_runs';
const FLAGGED = 'agent_runs_select_policy';
// Cluster-wide roles outlive a failed run's database, so the name is unique
// per process (house pattern of catalog.integration.test.ts) and afterAll
// revokes everything the role holds before dropping it.
const PROBE_ROLE = `agent_runs_rls_probe_${process.pid}`;
// Synthetic ids: a fixture uuid only ever matches other fixture uuids.
const OWN_ACCOUNT = '11111111-1111-1111-1111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-2222-2222-222222222222';
const MEMBER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MEMBER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ADMIN = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

let client: pg.Client;
let ownedStub = false;
let ownedUserRole = false;

async function raw(sql: string) {
  return client.query(sql);
}

async function scalar(sql: string): Promise<string | null> {
  const result = await client.query(sql);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? String(Object.values(row)[0]) : null;
}

/** pg_policies renders per search_path (with auth on the path it even drops
 *  the `auth.` prefix); read it under one pinned path so assertions and the
 *  migration's own wrap see the same rendering. */
async function policies(): Promise<Array<Record<string, unknown>>> {
  await raw('BEGIN');
  await raw('SET LOCAL search_path = public');
  const result = await client.query(
    `SELECT policyname, cmd, permissive, roles::text AS roles, qual::text, with_check::text
     FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_runs'
     ORDER BY policyname`,
  );
  await raw('COMMIT');
  return result.rows as Array<Record<string, unknown>>;
}

/** pg_policies renders per search_path; compare quals modulo that rendering.
 *  The scalar sub-select the wrap introduces deparses with a target alias
 *  (`( SELECT auth.uid() AS uid)`), so strip that alias too. */
function normalize(qual: string | null): string {
  return unqualify(qual ?? '')
    .toLowerCase()
    .replace(/\(\s*select\s+(auth\.(?:uid|role|jwt|email)\(\))(?:\s+as\s+\w+)?\)/g, '(select $1)')
    .replace(/\s+/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim();
}

/** Row count a NOBYPASSRLS role sees, with the JWT subject set per transaction. */
async function probeRowCount(subject?: string): Promise<string> {
  await raw('BEGIN');
  await raw(`SET LOCAL ROLE ${PROBE_ROLE}`);
  if (subject) await raw(`SET LOCAL request.jwt.claim.sub = '${subject}'`);
  const count = await scalar('SELECT count(*) FROM public.agent_runs');
  await raw('ROLLBACK');
  return count ?? 'error';
}

/** The plan a NOBYPASSRLS role gets for a plain read, with RLS active. */
async function probePlan(subject: string): Promise<string> {
  await raw('BEGIN');
  await raw(`SET LOCAL ROLE ${PROBE_ROLE}`);
  await raw(`SET LOCAL request.jwt.claim.sub = '${subject}'`);
  const plan = await raw('EXPLAIN (COSTS OFF) SELECT id FROM public.agent_runs');
  await raw('ROLLBACK');
  return plan.rows.map((row) => Object.values(row)[0]).join('\n');
}

async function ensureSharedObjects(): Promise<void> {
  // Supabase databases carry the real one; a bare PostgreSQL gets a stub with
  // the same contract, so the policy's expression is well-formed.
  if ((await scalar(`SELECT to_regprocedure('auth.uid()')`)) === 'null') {
    await raw('CREATE SCHEMA IF NOT EXISTS auth');
    await raw(
      `CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
         $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`,
    );
  }
  // The legacy basejump role helper is SECURITY DEFINER, so the probe needs no
  // grant on the backing table; create it only where the baseline did not.
  if ((await scalar(`SELECT to_regprocedure('basejump.has_role_on_account(uuid)')`)) === 'null') {
    ownedStub = true;
    await raw('CREATE SCHEMA IF NOT EXISTS basejump');
    await raw(
      `CREATE FUNCTION basejump.has_role_on_account(p_account_id uuid) RETURNS boolean
         LANGUAGE sql SECURITY DEFINER STABLE AS
         $$ SELECT EXISTS (
              SELECT 1 FROM basejump.account_user au
              WHERE au.account_id = p_account_id AND au.user_id = auth.uid()) $$`,
    );
  }
}

async function grantProbe(): Promise<void> {
  if ((await scalar(`SELECT to_regrole('${PROBE_ROLE}')`)) === 'null') {
    await raw(`CREATE ROLE ${PROBE_ROLE} NOLOGIN NOBYPASSRLS`);
  }
  await raw(`GRANT USAGE ON SCHEMA public, basejump TO ${PROBE_ROLE}`);
  await raw(
    `GRANT SELECT ON ${TABLE}, public.threads, public.projects, public.user_roles TO ${PROBE_ROLE}`,
  );
  await raw(`GRANT ${PROBE_ROLE} TO CURRENT_USER`);
}

/** The qual prod's delete, insert and update policies share verbatim. */
const SIBLING_QUAL = `EXISTS (
  SELECT 1 FROM public.threads
  LEFT JOIN public.projects ON public.threads.project_id = public.projects.project_id
  WHERE public.threads.thread_id = agent_runs.thread_id
    AND (basejump.has_role_on_account(public.threads.account_id)
      OR basejump.has_role_on_account(public.projects.account_id))
)`;

/**
 * The prod shape: the legacy tables carry `is_public`, and the five policies
 * are the ones prod's pg_policies held when this issue was filed (semantics
 * 1:1; the deparsed rendering may differ). `agent_runs_select_policy` is the
 * one the advisor flags: two bare `auth.uid()` calls.
 */
async function prodShapedFixture(): Promise<void> {
  await raw(`
    CREATE TABLE public.projects (
      project_id uuid PRIMARY KEY,
      account_id uuid NOT NULL,
      is_public boolean NOT NULL DEFAULT false
    );
    CREATE TABLE public.threads (
      thread_id uuid PRIMARY KEY,
      project_id uuid REFERENCES public.projects(project_id),
      account_id uuid NOT NULL,
      is_public boolean NOT NULL DEFAULT false
    );
    CREATE TABLE public.user_roles (
      user_id uuid NOT NULL,
      role public.user_role NOT NULL
    );
    CREATE TABLE ${TABLE} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES public.threads(thread_id)
    );
    ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.projects (project_id, account_id, is_public) VALUES
      ('a1aaaaa1-1111-1111-1111-111111111101', '${OWN_ACCOUNT}', false),
      ('b2bbbb22-2222-2222-2222-222222222202', '${OTHER_ACCOUNT}', false),
      ('c3ccccc3-3333-3333-3333-333333333303', '${OTHER_ACCOUNT}', true),
      ('d4ddddd4-4444-4444-4444-444444444404', '${OTHER_ACCOUNT}', false);
    INSERT INTO public.threads (thread_id, project_id, account_id, is_public) VALUES
      ('e1eeeee1-1111-1111-1111-111111111101', 'a1aaaaa1-1111-1111-1111-111111111101', '${OWN_ACCOUNT}', false),
      ('f2fffff2-2222-2222-2222-222222222202', 'b2bbbb22-2222-2222-2222-222222222202', '${OTHER_ACCOUNT}', false),
      ('a3aaaaa3-3333-3333-3333-333333333303', 'c3ccccc3-3333-3333-3333-333333333303', '${OTHER_ACCOUNT}', false),
      ('b4bbbbb4-4444-4444-4444-444444444404', 'd4ddddd4-4444-4444-4444-444444444404', '${OTHER_ACCOUNT}', true);
    INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}', 'admin');
    INSERT INTO ${TABLE} (thread_id) VALUES
      ('e1eeeee1-1111-1111-1111-111111111101'),
      ('f2fffff2-2222-2222-2222-222222222202'),
      ('a3aaaaa3-3333-3333-3333-333333333303'),
      ('b4bbbbb4-4444-4444-4444-444444444404');
    CREATE POLICY agent_run_delete_policy ON ${TABLE} FOR DELETE USING (${SIBLING_QUAL});
    CREATE POLICY agent_run_insert_policy ON ${TABLE} FOR INSERT WITH CHECK (${SIBLING_QUAL});
    CREATE POLICY agent_run_select_policy ON ${TABLE} FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM public.threads
        LEFT JOIN public.projects ON public.threads.project_id = public.projects.project_id
        WHERE public.threads.thread_id = agent_runs.thread_id
          AND (public.projects.is_public
            OR basejump.has_role_on_account(public.threads.account_id)
            OR basejump.has_role_on_account(public.projects.account_id))
      )
    );
    CREATE POLICY agent_run_update_policy ON ${TABLE} FOR UPDATE USING (${SIBLING_QUAL});
    CREATE POLICY agent_runs_select_policy ON ${TABLE} FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM public.threads
        WHERE public.threads.thread_id = agent_runs.thread_id
          AND (public.threads.is_public
            OR public.threads.account_id = auth.uid()
            OR basejump.has_role_on_account(public.threads.account_id)
            OR EXISTS (
              SELECT 1 FROM public.projects
              WHERE public.projects.project_id = public.threads.project_id
                AND (public.projects.is_public
                  OR basejump.has_role_on_account(public.projects.account_id))))
      )
      OR EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE public.user_roles.user_id = auth.uid()
          AND public.user_roles.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])
      )
    );
  `);
}

/**
 * The dev shape: the same legacy table family without `is_public` (dev's
 * public.projects/threads never had the column), so the stored policy cannot
 * reference it. Dev's exact stored text was never readable from this sandbox;
 * what matters here is that the migration applies under dev's migrate-role
 * search_path and alters the expression it finds there.
 */
async function devShapedFixture(): Promise<void> {
  await raw(`
    CREATE TABLE public.projects (
      project_id uuid PRIMARY KEY,
      account_id uuid NOT NULL
    );
    CREATE TABLE public.threads (
      thread_id uuid PRIMARY KEY,
      project_id uuid REFERENCES public.projects(project_id),
      account_id uuid NOT NULL
    );
    CREATE TABLE public.user_roles (
      user_id uuid NOT NULL,
      role public.user_role NOT NULL
    );
    CREATE TABLE ${TABLE} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES public.threads(thread_id)
    );
    ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.projects (project_id, account_id) VALUES
      ('a1aaaaa1-1111-1111-1111-111111111101', '${OWN_ACCOUNT}'),
      ('b2bbbb22-2222-2222-2222-222222222202', '${OTHER_ACCOUNT}');
    INSERT INTO public.threads (thread_id, project_id, account_id) VALUES
      ('e1eeeee1-1111-1111-1111-111111111101', 'a1aaaaa1-1111-1111-1111-111111111101', '${OWN_ACCOUNT}'),
      ('f2fffff2-2222-2222-2222-222222222202', 'b2bbbb22-2222-2222-2222-222222222202', '${OTHER_ACCOUNT}');
    INSERT INTO public.user_roles (user_id, role) VALUES ('${ADMIN}', 'admin');
    INSERT INTO ${TABLE} (thread_id) VALUES
      ('e1eeeee1-1111-1111-1111-111111111101'),
      ('f2fffff2-2222-2222-2222-222222222202');
    CREATE POLICY agent_runs_select_policy ON ${TABLE} FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM public.threads
        WHERE public.threads.thread_id = agent_runs.thread_id
          AND (public.threads.account_id = auth.uid()
            OR basejump.has_role_on_account(public.threads.account_id))
      )
      OR EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE public.user_roles.user_id = auth.uid()
          AND public.user_roles.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])
      )
    );
  `);
}

async function dropFixture(): Promise<void> {
  await raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  await raw('DROP TABLE IF EXISTS public.threads CASCADE');
  await raw('DROP TABLE IF EXISTS public.projects CASCADE');
  await raw('DROP TABLE IF EXISTS public.user_roles CASCADE');
}

async function applyMigration(): Promise<void> {
  const [name] = migrationNames;
  if (!name) throw new Error('no agent_runs_rls_auth_initplan migration file found');
  const migration = await Bun.file(resolve(migrationDirectory, name)).text();
  // node-pg-migrate runs each .sql file inside one transaction; mirror that.
  await raw(`BEGIN;\n${migration}\nCOMMIT;`);
}

/** Apply the migration from a session whose search_path mirrors dev's
 *  migrate role, where bare names resolve kortix.* first. */
async function applyMigrationUnderDevSearchPath(): Promise<void> {
  const [name] = migrationNames;
  if (!name) throw new Error('no agent_runs_rls_auth_initplan migration file found');
  const migration = await Bun.file(resolve(migrationDirectory, name)).text();
  await raw(`SET search_path = kortix, public, extensions;\nBEGIN;\n${migration}\nCOMMIT;`);
}

describe.skipIf(!databaseUrl)('agent_runs RLS auth-initplan migration — real PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: setupUrl });
    await client.connect();
    await ensureSharedObjects();
    if ((await scalar(`SELECT to_regtype('public.user_role')`)) === 'null') {
      ownedUserRole = true;
      await raw(`CREATE TYPE public.user_role AS ENUM ('admin', 'super_admin', 'member')`);
    }
    // One rendering for every pg_policies read and every fixture policy; the
    // fixtures are fully schema-qualified, so the pin cannot re-bind them.
    await raw('SET search_path = public');
    await raw(`INSERT INTO basejump.account_user (account_id, user_id, account_role) VALUES
      ('${OWN_ACCOUNT}', '${MEMBER_A}', 'owner'), ('${OTHER_ACCOUNT}', '${MEMBER_B}', 'owner')
      ON CONFLICT DO NOTHING`);
  });

  afterAll(async () => {
    if (!client) return;
    await dropFixture();
    if (ownedUserRole) await raw('DROP TYPE IF EXISTS public.user_role CASCADE');
    if (ownedStub) await raw('DROP FUNCTION IF EXISTS basejump.has_role_on_account(uuid)');
    await raw(`REVOKE USAGE ON SCHEMA public, basejump FROM ${PROBE_ROLE}`);
    await raw(`DROP OWNED BY ${PROBE_ROLE}`);
    // The beforeAll membership grant is a cluster-scoped dependency that
    // DROP OWNED BY (database-scoped) does not remove.
    await raw(`REVOKE ${PROBE_ROLE} FROM CURRENT_USER`);
    await raw(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
    await client.end();
  });

  test('wraps the flagged policy in place: InitPlan, identical visibility, siblings untouched', async () => {
    await dropFixture();
    await prodShapedFixture();
    await grantProbe();

    const before = await policies();
    expect(before).toHaveLength(5);
    // The advisor's red state: bare auth.uid(), evaluated per row. The plan
    // signal is the per-row filter evaluating the call inline — the
    // COALESCE(NULLIF(current_setting(...))) form — inside the correlated
    // threads subplan. The admin branch's user_roles subquery is uncorrelated
    // with agent_runs and plans as an InitPlan either way, so a bare
    // "InitPlan" substring is not the red signal.
    const flaggedBefore = before.find((p) => p.policyname === FLAGGED);
    expect(String(flaggedBefore?.qual)).toMatch(/auth\.uid\(\)/);
    expect(String(flaggedBefore?.qual)).not.toMatch(/select\s+\(?\s*(auth\.)?uid/i);
    const planBefore = await probePlan(MEMBER_A);
    expect(planBefore).toMatch(
      /account_id = \(?COALESCE\(NULLIF\(current_setting\('request\.jwt\.claim\.sub/,
    );

    // Visibility before the rewrite, per access path.
    const visibilityBefore = {
      memberA: await probeRowCount(MEMBER_A),
      memberB: await probeRowCount(MEMBER_B),
      admin: await probeRowCount(ADMIN),
      anonymous: await probeRowCount(),
    };
    expect(visibilityBefore).toEqual({ memberA: '3', memberB: '3', admin: '4', anonymous: '2' });

    await applyMigration();

    const after = await policies();
    expect(after).toHaveLength(5);
    // Every policy keeps its identity; the flagged one gained the wraps.
    for (const [i, policy] of after.entries()) {
      expect(policy.policyname).toBe(before[i].policyname);
      expect(policy.cmd).toBe(before[i].cmd);
      expect(policy.permissive).toBe(before[i].permissive);
      expect(policy.roles).toBe(before[i].roles);
      if (policy.policyname !== FLAGGED) {
        expect(normalize(String(policy.qual))).toBe(normalize(String(before[i].qual)));
      }
    }
    const flaggedAfter = after.find((p) => p.policyname === FLAGGED);
    expect(String(flaggedAfter?.qual)).toMatch(/select\s+\(?\s*(auth\.)?uid/i);
    // The stored expression is the old one with only the auth calls wrapped.
    expect(normalize(String(flaggedAfter?.qual))).toBe(
      normalize(String(flaggedBefore?.qual)).replace(/auth\.uid\(\)/g, '(select auth.uid())'),
    );
    // The advisor's green state: the correlated filter now references the
    // wrapped call as a one-per-statement InitPlan instead of evaluating it
    // per row.
    const planAfter = await probePlan(MEMBER_A);
    expect(planAfter).toMatch(/account_id = \(InitPlan \d+\)\.col1/);
    expect(planAfter).not.toMatch(/account_id = \(?COALESCE/);
    expect(await probeRowCount(MEMBER_A)).toBe(visibilityBefore.memberA);
    expect(await probeRowCount(MEMBER_B)).toBe(visibilityBefore.memberB);
    expect(await probeRowCount(ADMIN)).toBe(visibilityBefore.admin);
    expect(await probeRowCount()).toBe(visibilityBefore.anonymous);
  });

  test('re-applying is a no-op: no nesting, no second apply effect', async () => {
    await applyMigration();
    const before = await policies();
    await applyMigration();
    const after = await policies();
    expect(after).toHaveLength(before.length);
    for (const [i, policy] of after.entries()) {
      expect(policy.policyname).toBe(before[i].policyname);
      expect(normalize(String(policy.qual))).toBe(normalize(String(before[i].qual)));
    }
    expect(await probePlan(MEMBER_A)).toMatch(/account_id = \(InitPlan \d+\)\.col1/);
  });

  test('applies cleanly under dev migrate-role search_path and binds public.*', async () => {
    await dropFixture();
    await devShapedFixture();
    await grantProbe();
    // Dev's role resolves bare names kortix-first; the migrated template
    // database has kortix.projects/kortix.threads, so an unguarded re-parse
    // of the stored expression would bind (or fail on) kortix.* — the #8852
    // incident's second failure mode.
    await applyMigrationUnderDevSearchPath();

    // The pin was transaction-local: the session path survived the apply.
    expect(await scalar('SHOW search_path')).toMatch(/kortix/);
    await raw('SET search_path = public');

    const flagged = (await policies()).find((p) => p.policyname === FLAGGED);
    expect(String(flagged?.qual)).toMatch(/select\s+\(?\s*(auth\.)?uid/i);
    expect(await probePlan(MEMBER_A)).toMatch(/account_id = \(InitPlan \d+\)\.col1/);
    // The wrapped subquery still reads public.threads: the member sees the
    // own-account row even though kortix.threads holds no fixture rows.
    expect(await probeRowCount(MEMBER_A)).toBe('1');
    expect(await probeRowCount(MEMBER_B)).toBe('1');
    expect(await probeRowCount(ADMIN)).toBe('2');
    expect(await probeRowCount()).toBe('0');
  });

  test('is a no-op where the legacy table does not exist (baseline databases)', async () => {
    await dropFixture();
    await applyMigration();
    expect(await scalar(`SELECT to_regclass('${TABLE}') IS NULL`)).toBe('true');
    expect(await policies()).toHaveLength(0);
  });

  test('never invents a policy on a table whose RLS runs with none', async () => {
    await dropFixture();
    await raw(`CREATE TABLE ${TABLE} (id uuid PRIMARY KEY, thread_id uuid)`);
    await raw(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
    await applyMigration();
    expect(await policies()).toHaveLength(0);
  });
});
