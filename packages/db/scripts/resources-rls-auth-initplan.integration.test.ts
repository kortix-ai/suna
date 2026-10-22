/**
 * The `public.resources` RLS initplan rewrite, against a real PostgreSQL.
 *
 * The Supabase performance advisor flags `public.resources` (KRTX-1147): all
 * four account-membership policies call `auth.uid()` bare, so Postgres
 * re-evaluates it for every row instead of once per statement as an init plan
 * (lint `auth_rls_initplan`). The migration rewrites the four policies with
 * `(select auth.uid())` — Supabase's remediation — keeping each policy's name,
 * role, command, permissiveness and predicate otherwise identical.
 *
 * `public.resources` is a retired-Suna (agentpress) table: the baseline never
 * creates it and drizzle models no `public.resources`. The suite rebuilds the
 * legacy state on the lane's migrated database and asserts, in order:
 *   1. the fix migration is a guarded no-op on the fresh-install shape,
 *   2. the advisor's rule (supabase/splinter 0003_auth_rls_initplan, the
 *      `auth.uid()` branch) flags all four legacy policies — the finding
 *      reproduced,
 *   3. after the committed migration file applies, no policy is flagged, every
 *      policy keeps its shape (command, role, expression slot, the UPDATE
 *      policy's USING-only implicit check), and the plan of a plain read turns
 *      the per-row call into an InitPlan,
 *   4. row access is unchanged: a member of account A sees and writes only
 *      account A's rows, account B's stay invisible, the `account_id IS NULL`
 *      exception keeps applying everywhere the old policy applied it (and
 *      nowhere it did not), and a re-apply leaves the same four policies.
 *
 * The probe role is not the table owner and NOBYPASSRLS, so RLS applies to it
 * exactly as it applies to an authenticated client, and the plan it gets is
 * the plan that client gets.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
// Setup and the RLS probe need a session that may SET ROLE to a NOBYPASSRLS
// role: the db-suites lane passes its superuser URL beside TEST_DATABASE_URL
// for exactly that kind of work. A single-URL checkout falls back to it.
const setupUrl = process.env.TEST_DATABASE_SUPERUSER_URL ?? databaseUrl;

const migrationDirectory = resolve(import.meta.dir, '..', 'migrations');
const migrationNames = Array.from(
  new Bun.Glob('*_resources_rls_auth_initplan.sql').scanSync({ cwd: migrationDirectory }),
);

const TABLE = 'public.resources';
const PROBE_ROLE = 'resources_rls_probe';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROW_A = '11111111-1111-4111-8111-111111111111';
const ROW_B = '22222222-2222-4222-8222-222222222222';
const ROW_NULL = '33333333-3333-4333-8333-333333333333';

/** The four legacy policies exactly as prod carries them (bare auth.uid()).
 *  `slot` says which expression the command carries (prod shapes: SELECT,
 *  UPDATE and DELETE policies are USING-only; the INSERT policy is
 *  WITH CHECK-only). */
const VIEW_POLICY = {
  name: 'Account members can view resources for their accounts',
  cmd: 'SELECT',
  slot: 'USING',
} as const;
const UPDATE_POLICY = {
  name: 'Account members can update resources for their accounts',
  cmd: 'UPDATE',
  slot: 'USING',
} as const;
const INSERT_POLICY = {
  name: 'Account members can insert resources for their accounts',
  cmd: 'INSERT',
  slot: 'WITH CHECK',
} as const;
const DELETE_POLICY = {
  name: 'Account members can delete resources for their accounts',
  cmd: 'DELETE',
  slot: 'USING',
} as const;
const POLICY_DEFS = [VIEW_POLICY, UPDATE_POLICY, INSERT_POLICY, DELETE_POLICY];

let client: pg.Client;

async function raw(sql: string) {
  return client.query(sql);
}

async function scalar(sql: string): Promise<string | null> {
  const result = await client.query(sql);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? String(Object.values(row)[0]) : null;
}

async function policies(): Promise<Array<Record<string, unknown>>> {
  // pg_get_expr (what pg_policies.qual holds) qualifies a function only when
  // its schema is not on the querying session's search_path. Pin public so
  // auth.uid() always renders qualified — otherwise the superuser's
  // search_path hides the auth. prefix and the bare-vs-wrapped check below
  // cannot tell the two shapes apart.
  await raw('BEGIN');
  await raw('SET LOCAL search_path = public');
  const result = await client.query(
    `SELECT policyname, cmd, permissive, roles::text AS roles, qual::text, with_check::text
     FROM pg_policies WHERE schemaname = 'public' AND tablename = 'resources'
     ORDER BY policyname`,
  );
  await raw('ROLLBACK');
  return result.rows as Array<Record<string, unknown>>;
}

/** The advisor's `auth_rls_initplan` rule for auth.uid(): the call appears
 *  unwrapped — bare, with no `select` in front of it. Checks both expression
 *  slots, because the INSERT policy lives in with_check. */
function flagged(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.filter((row) => {
    const expressions = [row.qual as string | null, row.with_check as string | null];
    return expressions.some(
      (expression) =>
        expression !== null &&
        /auth\.uid\(\)/i.test(expression) &&
        !/select\s+(auth\.)?uid\(\)/i.test(expression),
    );
  });
}

/** The plan a NOBYPASSRLS role gets for a plain read, with RLS active. */
async function probePlan(subject: string): Promise<string> {
  await raw('BEGIN');
  await raw(`SET LOCAL ROLE ${PROBE_ROLE}`);
  await raw(`SET LOCAL request.jwt.claim.sub = '${subject}'`);
  const plan = await raw(`EXPLAIN (COSTS OFF) SELECT id FROM ${TABLE}`);
  await raw('ROLLBACK');
  return plan.rows.map((row) => Object.values(row)[0]).join('\n');
}

/** Every write below runs inside one transaction so a rejected statement
 *  cannot abort the connection; the caller asserts on the pg error code. */
async function asUser(
  subject: string,
  fn: (query: (sql: string, values?: unknown[]) => Promise<pg.QueryResult>) => Promise<void>,
): Promise<void> {
  await raw('BEGIN');
  await raw(`SET LOCAL ROLE ${PROBE_ROLE}`);
  await raw(`SET LOCAL request.jwt.claim.sub = '${subject}'`);
  try {
    await fn((sql, values) => client.query(sql, values));
  } finally {
    await raw('ROLLBACK');
  }
}

/** The PostgreSQL error code of a driver error, or undefined. */
function pgErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown };
  return typeof value.code === 'string' ? value.code : undefined;
}

/** The legacy table and its four policies, exactly as the long-lived prod
 *  database carries them: bare auth.uid() in every expression. */
async function legacyFixture(): Promise<void> {
  if ((await scalar(`SELECT to_regprocedure('auth.uid()')`)) === 'null') {
    // Supabase databases carry the real one; a bare PostgreSQL gets a stub
    // with the same contract, so the policy's expression is well-formed.
    await raw('CREATE SCHEMA IF NOT EXISTS auth');
    await raw(
      `CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
         $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`,
    );
  }
  if ((await scalar(`SELECT to_regclass('basejump.account_user')`)) === 'null') {
    // The migrated lane database has the stub test-prereqs.sql creates; a
    // bare PostgreSQL gets the same shape here.
    await raw('CREATE SCHEMA IF NOT EXISTS basejump');
    await raw(`CREATE TYPE basejump.account_role AS ENUM ('owner', 'member')`);
    await raw(`CREATE TABLE basejump.account_user (
      user_id uuid NOT NULL,
      account_id uuid NOT NULL,
      account_role basejump.account_role NOT NULL,
      PRIMARY KEY (user_id, account_id)
    )`);
  }
  await raw(`INSERT INTO basejump.account_user (user_id, account_id, account_role)
    VALUES ('${USER_A}', '${ACCOUNT_A}', 'owner'), ('${USER_B}', '${ACCOUNT_B}', 'owner')
    ON CONFLICT DO NOTHING`);

  await raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  await raw(`CREATE TABLE ${TABLE} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid,
    type text NOT NULL,
    external_id text,
    status text NOT NULL DEFAULT 'active',
    config jsonb DEFAULT '{}'::jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    last_used_at timestamptz,
    pooled_at timestamptz
  )`);
  await raw(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
  await raw(`CREATE POLICY "Account members can view resources for their accounts" ON ${TABLE}
    FOR SELECT
    USING ((account_id IS NULL) OR (EXISTS ( SELECT 1 FROM basejump.account_user
      WHERE ((account_user.account_id = resources.account_id) AND (account_user.user_id = auth.uid())))))`);
  await raw(`CREATE POLICY "Account members can update resources for their accounts" ON ${TABLE}
    FOR UPDATE
    USING ((account_id IS NULL) OR (EXISTS ( SELECT 1 FROM basejump.account_user
      WHERE ((account_user.account_id = resources.account_id) AND (account_user.user_id = auth.uid())))))`);
  await raw(`CREATE POLICY "Account members can insert resources for their accounts" ON ${TABLE}
    FOR INSERT
    WITH CHECK ((account_id IS NULL) OR (EXISTS ( SELECT 1 FROM basejump.account_user
      WHERE ((account_user.account_id = resources.account_id) AND (account_user.user_id = auth.uid())))))`);
  await raw(`CREATE POLICY "Account members can delete resources for their accounts" ON ${TABLE}
    FOR DELETE
    USING (EXISTS ( SELECT 1 FROM basejump.account_user
      WHERE ((account_user.account_id = resources.account_id) AND (account_user.user_id = auth.uid()))))`);

  await raw(`INSERT INTO ${TABLE} (id, account_id, type) VALUES
    ('${ROW_A}', '${ACCOUNT_A}', 'sandbox'),
    ('${ROW_B}', '${ACCOUNT_B}', 'sandbox'),
    ('${ROW_NULL}', NULL, 'sandbox')`);
  await raw(`GRANT SELECT ON ${TABLE} TO ${PROBE_ROLE}`);
}

async function applyMigration(): Promise<void> {
  const [name] = migrationNames;
  if (!name) throw new Error('no resources_rls_auth_initplan migration file found');
  const migration = await Bun.file(resolve(migrationDirectory, name)).text();
  // node-pg-migrate runs each .sql file inside one transaction; mirror that.
  await raw(`BEGIN;\n${migration}\nCOMMIT;`);
}

describe.skipIf(!databaseUrl)('public.resources RLS initplan migration — real PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: setupUrl });
    await client.connect();
    if ((await scalar(`SELECT to_regrole('${PROBE_ROLE}')`)) === 'null') {
      await raw(`CREATE ROLE ${PROBE_ROLE} NOLOGIN NOBYPASSRLS`);
    }
    await raw(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
    await raw(`GRANT ${PROBE_ROLE} TO CURRENT_USER`);
    // The legacy policy's subquery reads basejump.account_user and calls
    // auth.uid() as the querying role. Prod grants USAGE on both schemas to
    // postgres and authenticated; the lane's superuser-created stubs (and the
    // --no-privileges auth dump) carry no such grant, so mirror prod here.
    await raw('GRANT USAGE ON SCHEMA basejump TO PUBLIC');
    await raw('GRANT SELECT ON basejump.account_user TO PUBLIC');
    await raw(`GRANT USAGE ON SCHEMA auth TO ${PROBE_ROLE}`);
  });

  afterAll(async () => {
    if (!client) return;
    await raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await raw(`DELETE FROM basejump.account_user WHERE user_id IN ('${USER_A}', '${USER_B}')`);
    await raw(`REVOKE USAGE ON SCHEMA public FROM ${PROBE_ROLE}`);
    await raw(`REVOKE USAGE ON SCHEMA auth FROM ${PROBE_ROLE}`);
    await raw(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
    await client.end();
  });

  test('the legacy fixture is the shape the advisor flags: bare auth.uid() in all four policies', async () => {
    await legacyFixture();

    const rows = await policies();
    expect(rows).toHaveLength(4);
    expect(flagged(rows)).toHaveLength(4);
    for (const policy of POLICY_DEFS) {
      const row = rows.find((r) => r.policyname === policy.name);
      expect(row, policy.name).toBeDefined();
      expect(row?.cmd, policy.name).toBe(policy.cmd);
      const stored = policy.slot === 'USING' ? row?.qual : row?.with_check;
      expect(String(stored), policy.name).toContain('auth.uid()');
      expect(String(stored), policy.name).not.toMatch(/select\s+(auth\.)?uid/i);
    }
    expect(await probePlan(USER_A)).not.toContain('InitPlan');
  });

  test('wraps every auth call; identity, expression slots and the plan change in the advisor direction', async () => {
    await legacyFixture();
    await applyMigration();

    const rows = await policies();
    expect(rows).toHaveLength(4);
    expect(flagged(rows)).toHaveLength(0);
    for (const policy of POLICY_DEFS) {
      const row = rows.find((r) => r.policyname === policy.name);
      expect(row, policy.name).toBeDefined();
      expect(row?.cmd, policy.name).toBe(policy.cmd);
      expect(row?.permissive, policy.name).toBe('PERMISSIVE');
      expect(row?.roles, policy.name).toBe('{public}');
      const stored = policy.slot === 'USING' ? row?.qual : row?.with_check;
      expect(String(stored), policy.name).toMatch(/select\s+(auth\.)?uid\(\)/i);
    }
    // The UPDATE policy keeps USING-only: no explicit WITH CHECK, so Postgres
    // applies the USING expression as the implicit check, as prod does.
    const update = rows.find((r) => r.policyname === UPDATE_POLICY.name);
    expect(update?.with_check).toBeNull();

    expect(await probePlan(USER_A)).toContain('InitPlan');

    // A second apply leaves the same four policies with the same shapes.
    await applyMigration();
    const rowsAfterReapply = await policies();
    expect(rowsAfterReapply).toHaveLength(4);
    expect(flagged(rowsAfterReapply)).toHaveLength(0);
  });

  test('row access is unchanged: own account writable, other accounts invisible, NULL account_id exactly as before', async () => {
    await legacyFixture();
    await applyMigration();

    await raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO ${PROBE_ROLE}`);
    // The probe role is not the table owner, so RLS applies to it without
    // FORCE — the same rows an authenticated client would see.
    // User A (account A): sees own row + the NULL-account row.
    await asUser(USER_A, async (query) => {
      const visible = await query(`SELECT id::text, account_id::text FROM ${TABLE} ORDER BY id`);
      expect(visible.rows.map((r) => r.id)).toEqual([ROW_A, ROW_NULL]);
    });

    // User B (account B): sees only its own row + the NULL-account row (RLS
    // hides A's; the NULL exception is visible to every member).
    await asUser(USER_B, async (query) => {
      const visible = await query(`SELECT id::text FROM ${TABLE} ORDER BY id`);
      expect(visible.rows.map((r) => r.id)).toEqual([ROW_B, ROW_NULL]);
    });

    // INSERT: own account and the NULL exception pass; a foreign one is rejected.
    await asUser(USER_A, async (query) => {
      const own = await query(
        `INSERT INTO ${TABLE} (id, account_id, type) VALUES (gen_random_uuid(), '${ACCOUNT_A}', 'sandbox') RETURNING id::text`,
      );
      expect(own.rowCount).toBe(1);
    });
    await asUser(USER_A, async (query) => {
      const open = await query(
        `INSERT INTO ${TABLE} (id, account_id, type) VALUES (gen_random_uuid(), NULL, 'sandbox') RETURNING id::text`,
      );
      expect(open.rowCount).toBe(1);
    });
    await asUser(USER_A, async (query) => {
      let rejected = false;
      try {
        await query(
          `INSERT INTO ${TABLE} (id, account_id, type) VALUES (gen_random_uuid(), '${ACCOUNT_B}', 'sandbox')`,
        );
      } catch (error) {
        rejected = pgErrorCode(error) === '42501';
      }
      expect(rejected).toBe(true);
    });

    // UPDATE: own row updates; reparenting it to another account is rejected
    // by the implicit WITH CHECK; another account's row is invisible (0 rows).
    await asUser(USER_A, async (query) => {
      const own = await query(
        `UPDATE ${TABLE} SET status = 'paused' WHERE id = '${ROW_A}' RETURNING id::text`,
      );
      expect(own.rowCount).toBe(1);
    });
    await asUser(USER_A, async (query) => {
      let rejected = false;
      try {
        await query(`UPDATE ${TABLE} SET account_id = '${ACCOUNT_B}' WHERE id = '${ROW_A}'`);
      } catch (error) {
        rejected = pgErrorCode(error) === '42501';
      }
      expect(rejected).toBe(true);
    });
    await asUser(USER_A, async (query) => {
      const foreign = await query(
        `UPDATE ${TABLE} SET status = 'paused' WHERE id = '${ROW_B}' RETURNING id::text`,
      );
      expect(foreign.rowCount).toBe(0);
    });

    // DELETE: own row deletes; the NULL-account row and the foreign row are
    // invisible (the DELETE policy has no NULL branch, as in prod).
    await asUser(USER_A, async (query) => {
      const own = await query(`DELETE FROM ${TABLE} WHERE id = '${ROW_A}' RETURNING id::text`);
      expect(own.rowCount).toBe(1);
    });
    await asUser(USER_A, async (query) => {
      const open = await query(`DELETE FROM ${TABLE} WHERE id = '${ROW_NULL}' RETURNING id::text`);
      expect(open.rowCount).toBe(0);
    });
    await asUser(USER_A, async (query) => {
      const foreign = await query(`DELETE FROM ${TABLE} WHERE id = '${ROW_B}' RETURNING id::text`);
      expect(foreign.rowCount).toBe(0);
    });
  });

  test('is a no-op where the legacy table does not exist (baseline databases)', async () => {
    await raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);

    await applyMigration();

    expect(await scalar(`SELECT to_regclass('${TABLE}') IS NULL`)).toBe('true');
  });

  test('never invents a policy on a table whose RLS runs with none', async () => {
    await raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await raw(`CREATE TABLE ${TABLE} (account_id uuid)`);
    await raw(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);

    await applyMigration();

    expect(await policies()).toHaveLength(0);
  });
});
