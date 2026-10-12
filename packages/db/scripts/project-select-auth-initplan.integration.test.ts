/**
 * The `project_select_policy` RLS initplan rewrite, against a real PostgreSQL.
 *
 * The migration rewrites one legacy policy so its `auth.uid()` call is wrapped
 * in `(select ...)`, which Postgres plans once per statement as an init plan
 * instead of re-evaluating it for every row (Supabase advisor lint
 * `auth_rls_initplan`). Four things are worth a test: the migration is a
 * no-op where the legacy table does not exist (every baseline-built database);
 * the legacy state is the shape the advisor flags; the rewrite clears it while
 * the policy's identity and shape stay put; and row access is unchanged across
 * all three branches of the predicate (public projects, account members,
 * platform admins) plus the negative cases.
 *
 * The fixture DDL runs through TEST_DATABASE_SUPERUSER_URL: the lane role
 * cannot create objects in the public schema. The table is then reassigned to
 * the lane role and the migration applies through TEST_DATABASE_URL, so the
 * ALTER POLICY runs under exactly the privileges prod's migration runner has.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const laneUrl = process.env.TEST_DATABASE_URL;
const superuserUrl = process.env.TEST_DATABASE_SUPERUSER_URL ?? laneUrl;

const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_project_select_auth_initplan.sql').scanSync({ cwd: migrationDirectory }),
);

const TABLE = 'public.projects';
const POLICY = 'project_select_policy';
const PROBE_ROLE = 'projects_rls_probe';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCOUNT_Z = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** The advisor's `auth_rls_initplan` rule: a bare auth.uid() call in the policy. */
const LINTER_FINDS_BARE_AUTH_UID = `
  SELECT count(*) FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'projects'
    AND policyname = 'project_select_policy'
    AND qual LIKE '%auth.uid()%'
    AND lower(qual) NOT LIKE '%select auth.uid()%'
`;

/** The legacy policy exactly as prod carries it (pg_policies.qual, re-written as SQL). */
const LEGACY_POLICY_SQL = `
  CREATE POLICY project_select_policy ON public.projects FOR SELECT
    USING (
      (is_public = true)
      OR (basejump.has_role_on_account(account_id) = true)
      OR (EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_roles.user_id = auth.uid()
          AND user_roles.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])
      ))
    )
`;

/** The legacy table's columns, exactly as prod carries them. */
const LEGACY_TABLE_SQL = `
  CREATE TABLE public.projects (
    project_id uuid PRIMARY KEY,
    name text NOT NULL,
    description text,
    account_id uuid NOT NULL,
    sandbox jsonb,
    is_public boolean,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    is_sandbox_deleted boolean NOT NULL DEFAULT false,
    icon_name text,
    category text,
    sandbox_resource_id uuid,
    categories text[],
    last_categorized_at timestamptz
  )
`;

/** The legacy role enum and membership table, exactly as prod carries them. */
const LEGACY_USER_ROLES_SQL = `
  DO $fixture$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' AND t.typname = 'user_role'
    ) THEN
      CREATE TYPE public.user_role AS ENUM ('user', 'admin', 'super_admin');
    END IF;
    CREATE TABLE IF NOT EXISTS public.user_roles (
      user_id uuid NOT NULL,
      role public.user_role NOT NULL,
      granted_by uuid,
      granted_at timestamptz,
      metadata jsonb
    );
  END $fixture$
`;

/** The prod body of basejump.has_role_on_account (SECURITY DEFINER, STABLE). */
const HAS_ROLE_ON_ACCOUNT_SQL = `
  CREATE OR REPLACE FUNCTION basejump.has_role_on_account(
    account_id uuid,
    account_role basejump.account_role DEFAULT NULL::basejump.account_role
  ) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS $fn$
    SELECT EXISTS (
      SELECT 1 FROM basejump.account_user wu
      WHERE wu.user_id = auth.uid()
        AND wu.account_id = has_role_on_account.account_id
        AND (wu.account_role = has_role_on_account.account_role
             OR has_role_on_account.account_role IS NULL)
    )
  $fn$
`;

const FIXTURE_PROJECTS_SQL = `
  INSERT INTO public.projects (project_id, name, account_id, is_public) VALUES
    ('11111111-1111-4111-8111-000000000001', 'public project',    '${ACCOUNT_Z}', true),
    ('11111111-1111-4111-8111-000000000002', 'account A project', '${ACCOUNT_A}', false),
    ('11111111-1111-4111-8111-000000000003', 'account B project', '${ACCOUNT_B}', false),
    ('11111111-1111-4111-8111-000000000004', 'admin-only project', '${ACCOUNT_Z}', false)
`;

let admin: pg.Client;
let lane: pg.Client;
let laneRole: string;
let migrationSql: string;

async function scalar(client: pg.Client, sql: string): Promise<string | null> {
  const result = await client.query(sql);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? String(Object.values(row)[0]) : null;
}

async function policies(): Promise<Array<Record<string, unknown>>> {
  const result = await lane.query(
    `SELECT policyname, cmd, permissive, roles::text AS roles, qual::text, with_check::text
     FROM pg_policies WHERE schemaname = 'public' AND tablename = 'projects'`,
  );
  return result.rows as Array<Record<string, unknown>>;
}

/** Row counts the probe role sees; the subject is per-transaction because
 *  SET LOCAL rolls back with it. No subject means the request carried no JWT
 *  claim. */
async function probeRows(subject?: string): Promise<string[]> {
  await lane.query('BEGIN');
  await lane.query(`SET LOCAL ROLE ${PROBE_ROLE}`);
  if (subject) await lane.query(`SET LOCAL request.jwt.claim.sub = '${subject}'`);
  const rows = await lane.query('SELECT name FROM public.projects ORDER BY name');
  await lane.query('ROLLBACK');
  return rows.rows.map((row) => String((row as Record<string, unknown>).name));
}

/** The plan a NOBYPASSRLS role gets for a plain read, with RLS active. */
async function probePlan(subject: string): Promise<string> {
  await lane.query('BEGIN');
  await lane.query(`SET LOCAL ROLE ${PROBE_ROLE}`);
  await lane.query(`SET LOCAL request.jwt.claim.sub = '${subject}'`);
  const plan = await lane.query('EXPLAIN (COSTS OFF) SELECT project_id FROM public.projects');
  await lane.query('ROLLBACK');
  return plan.rows.map((row) => Object.values(row)[0]).join('\n');
}

async function legacyFixture(): Promise<void> {
  if ((await scalar(admin, `SELECT to_regprocedure('auth.uid()')`)) === 'null') {
    // Supabase databases carry the real one; a bare PostgreSQL gets a stub
    // with the same contract, so the policy's expression is well-formed.
    await admin.query('CREATE SCHEMA IF NOT EXISTS auth');
    await admin.query(
      `CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
         $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`,
    );
  }
  if (
    (await scalar(
      admin,
      `SELECT to_regprocedure('basejump.has_role_on_account(uuid, basejump.account_role)')`,
    )) === 'null'
  ) {
    await admin.query(HAS_ROLE_ON_ACCOUNT_SQL);
  }
  await admin.query(LEGACY_USER_ROLES_SQL);
  await admin.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  await admin.query(LEGACY_TABLE_SQL);
  await admin.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
  await admin.query(LEGACY_POLICY_SQL);
  await admin.query(FIXTURE_PROJECTS_SQL);
  await admin.query(
    `INSERT INTO basejump.account_user (user_id, account_id, account_role) VALUES ('${USER_A}', '${ACCOUNT_A}', 'owner'), ('${USER_B}', '${ACCOUNT_B}', 'owner')`,
  );
  await admin.query(`INSERT INTO public.user_roles (user_id, role) VALUES ('${USER_A}', 'admin')`);
  // The migration must run as the role prod's runner runs as: the table owner.
  await admin.query(`ALTER TABLE ${TABLE} OWNER TO ${laneRole}`);
  await admin.query(`GRANT SELECT ON ${TABLE} TO ${PROBE_ROLE}`);
  // The policy's admin branch reads user_roles as the querying role, so the
  // probe needs the same grant an authenticated client has on prod.
  await admin.query(`GRANT SELECT ON public.user_roles TO ${PROBE_ROLE}`);
  // The probe checks run from the lane client under SET ROLE.
  await admin.query(`GRANT ${PROBE_ROLE} TO ${laneRole}`);
}

/** Applies the committed migration file the way node-pg-migrate does: as the
 *  lane role, inside one transaction. */
async function applyMigration(): Promise<void> {
  const [name] = migrationNames;
  if (!name) throw new Error('no project_select_auth_initplan migration file found');
  if (!migrationSql) {
    migrationSql = await Bun.file(resolve(migrationDirectory, name)).text();
  }
  await lane.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);
}

describe.skipIf(!laneUrl)(
  'project_select_policy RLS auth_rls_initplan migration — real PostgreSQL',
  () => {
    beforeAll(async () => {
      lane = new pg.Client({ connectionString: laneUrl });
      await lane.connect();
      const who = await scalar(lane, 'SELECT current_user');
      if (!who) throw new Error('could not read the lane role name');
      laneRole = who;
      admin = new pg.Client({ connectionString: superuserUrl });
      await admin.connect();
      if ((await scalar(lane, `SELECT to_regrole('${PROBE_ROLE}')`)) === 'null') {
        await admin.query(`CREATE ROLE ${PROBE_ROLE} NOLOGIN NOBYPASSRLS`);
      }
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
    });

    afterAll(async () => {
      if (!admin) return;
      await admin.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await admin.query('DROP TABLE IF EXISTS public.user_roles CASCADE');
      await admin.query(
        `DELETE FROM basejump.account_user WHERE user_id IN ('${USER_A}', '${USER_B}')`,
      );
      await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${PROBE_ROLE}`);
      await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
      await lane.end();
      await admin.end();
    });

    test('fresh-install shape: the migration is a guarded no-op (no legacy table)', async () => {
      // The lane database is a fresh install shape: the legacy table must not
      // pre-exist, or this suite would be testing a state prod is not in.
      expect(await scalar(lane, `SELECT to_regclass('${TABLE}') IS NOT NULL`)).toBe('false');

      await applyMigration();

      expect(await scalar(lane, `SELECT to_regclass('${TABLE}') IS NOT NULL`)).toBe('false');
      expect(await policies()).toHaveLength(0);
    });

    describe('with the legacy state present', () => {
      beforeAll(async () => {
        await legacyFixture();
      });

      test('the legacy policy re-evaluates auth.uid() per row (the advisor finding)', async () => {
        expect(await scalar(lane, LINTER_FINDS_BARE_AUTH_UID)).toBe('1');
        // And the planner really evaluates it per row: the bare call is inlined
        // into the user_roles filter, so every scanned row re-evaluates it.
        expect(await probePlan(USER_A)).toContain("current_setting('request.jwt.claim.sub'");
      });

      test('the migration wraps the auth call, preserves the policy shape, and clears the finding', async () => {
        await applyMigration();

        const [policy] = await policies();
        expect(policy?.policyname).toBe(POLICY);
        expect(policy?.cmd).toBe('SELECT');
        expect(policy?.permissive).toBe('PERMISSIVE');
        expect(policy?.roles).toBe('{public}');
        expect(String(policy?.qual)).toContain('( SELECT auth.uid()');
        expect(policy?.with_check).toBeNull();
        expect(await scalar(lane, LINTER_FINDS_BARE_AUTH_UID)).toBe('0');
        // ALTER POLICY touches neither the table's RLS flags nor the policy's
        // role list; assert both so "shape preserved" is checked, not assumed.
        const rls = await lane.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'projects'`,
        );
        expect(rls.rows[0].relrowsecurity).toBe(true);
        expect(rls.rows[0].relforcerowsecurity).toBe(false);

        // The wrap becomes its own init plan, evaluated once per statement;
        // the row filter reads its result instead of calling the function.
        const plan = await probePlan(USER_A);
        expect(plan).not.toContain("current_setting('request.jwt.claim.sub'");
        expect(plan).toContain('InitPlan');
      });

      test('row access is unchanged across every branch of the predicate', async () => {
        // A platform admin (a user_roles row): every project. The admin-only
        // one has no other entitlement for this user (not public, an account
        // with no membership), so its row isolates the admin branch.
        expect(await probeRows(USER_A)).toEqual([
          'account A project',
          'account B project',
          'admin-only project',
          'public project',
        ]);
        // A plain account member (a basejump.account_user row, no admin role):
        // public projects and own account projects, never the admin-only one.
        expect(await probeRows(USER_B)).toEqual(['account B project', 'public project']);
        // An anonymous request: only the public branch, which calls no auth
        // function.
        expect(await probeRows()).toEqual(['public project']);
      });

      test('a second apply leaves the same single policy with the same plan', async () => {
        await applyMigration();
        expect(await policies()).toHaveLength(1);
        expect(await probePlan(USER_A)).toContain('InitPlan');
      });

      test('never invents a policy when the legacy policy is absent', async () => {
        await lane.query(`DROP POLICY IF EXISTS ${POLICY} ON ${TABLE}`);

        await applyMigration();

        expect(await policies()).toHaveLength(0);
        // RLS with no policy denies every row to the probe role — the rewrite
        // must not open that access back up.
        expect(await probeRows()).toEqual([]);
      });
    });
  },
);
