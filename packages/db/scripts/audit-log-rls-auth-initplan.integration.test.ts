/**
 * The `audit_log` RLS initplan rewrite, against a real PostgreSQL.
 *
 * The migration rewrites two legacy policies so their `auth.role()` /
 * `auth.uid()` calls are wrapped in `(select ...)`, which Postgres evaluates
 * once per statement as an init plan instead of once per row (Supabase advisor
 * lint `auth_rls_initplan`, KRTX-1134). Four things are worth a test: the
 * fixture presents the exact shape prod carries and the advisor flags; the
 * wrap changes the plan while every policy's identity and semantics stay put;
 * the migration is a no-op where the legacy table does not exist (every
 * baseline-built database); and it never invents a policy on a table whose
 * RLS runs with none, which would open access that was closed.
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
  new Bun.Glob('*_wrap_audit_log_rls_auth_initplan.sql').scanSync({ cwd: migrationDirectory }),
);

const TABLE = 'public.audit_log';
const SERVICE_POLICY = 'Service role manages audit log';
const USER_POLICY = 'Users can view own audit log';
const PROBE_ROLE = 'audit_log_rls_probe';
const OWN_USER = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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
  const result = await client.query(
    `SELECT policyname, cmd, permissive, roles::text AS roles, qual::text, with_check::text
     FROM pg_policies WHERE schemaname = 'public' AND tablename = 'audit_log'
     ORDER BY policyname`,
  );
  return result.rows as Array<Record<string, unknown>>;
}

/** The plan a NOBYPASSRLS role gets for a plain read, with RLS active. */
async function probePlan(subject: string): Promise<string> {
  await raw('BEGIN');
  await raw(`SET LOCAL ROLE ${PROBE_ROLE}`);
  await raw(`SET LOCAL request.jwt.claim.sub = '${subject}'`);
  const plan = await raw('EXPLAIN (COSTS OFF) SELECT id FROM public.audit_log');
  await raw('ROLLBACK');
  return plan.rows.map((row) => Object.values(row)[0]).join('\n');
}

/** Row count the same role sees; the subject, like the plan probe, is
 *  per-transaction because SET LOCAL rolls back with it. No subject means the
 *  request carried no JWT claim. */
async function probeRowCount(subject?: string): Promise<string> {
  await raw('BEGIN');
  await raw(`SET LOCAL ROLE ${PROBE_ROLE}`);
  if (subject) await raw(`SET LOCAL request.jwt.claim.sub = '${subject}'`);
  const count = await scalar('SELECT count(*) FROM public.audit_log');
  await raw('ROLLBACK');
  return count ?? 'error';
}

/** The exact shape prod carries and the advisor flags: both policies call
 *  auth.role() / auth.uid() bare. */
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
  if ((await scalar(`SELECT to_regprocedure('auth.role()')`)) === 'null') {
    await raw(
      `CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
         $$ SELECT current_setting('request.jwt.claim.role', true) $$`,
    );
  }
  await raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
  await raw(`CREATE TABLE ${TABLE} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL
  )`);
  await raw(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
  await raw(`CREATE POLICY "${SERVICE_POLICY}" ON ${TABLE}
    USING ((auth.role() = 'service_role'::text))`);
  await raw(`CREATE POLICY "${USER_POLICY}" ON ${TABLE}
    FOR SELECT USING ((auth.uid() = account_id))`);
  await raw(`INSERT INTO ${TABLE} (id, account_id) VALUES
    ('11111111-1111-1111-1111-111111111111', '${OWN_USER}'),
    ('22222222-2222-2222-2222-222222222222', '${OTHER_USER}')`);
  await raw(`GRANT SELECT ON ${TABLE} TO ${PROBE_ROLE}`);
}

async function applyMigration(): Promise<void> {
  const [name] = migrationNames;
  if (!name) throw new Error('no wrap_audit_log_rls_auth_initplan migration file found');
  const migration = await Bun.file(resolve(migrationDirectory, name)).text();
  // node-pg-migrate runs each .sql file inside one transaction; mirror that.
  await raw(`BEGIN;\n${migration}\nCOMMIT;`);
}

describe.skipIf(!databaseUrl)('audit_log RLS initplan migration — real PostgreSQL', () => {
  beforeAll(async () => {
    client = new pg.Client({ connectionString: setupUrl });
    await client.connect();
    if ((await scalar(`SELECT to_regrole('${PROBE_ROLE}')`)) === 'null') {
      await raw(`CREATE ROLE ${PROBE_ROLE} NOLOGIN NOBYPASSRLS`);
    }
    await raw(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
    await raw(`GRANT ${PROBE_ROLE} TO CURRENT_USER`);
  });

  afterAll(async () => {
    if (!client) return;
    await raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await raw(`REVOKE USAGE ON SCHEMA public FROM ${PROBE_ROLE}`);
    await raw(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
    await client.end();
  });

  test('the legacy fixture is the shape the advisor flags: bare auth calls, no init plan', async () => {
    await legacyFixture();

    const byName = new Map((await policies()).map((p) => [p.policyname, p]));
    expect(byName.get(SERVICE_POLICY)?.qual).toMatch(/\brole\(\)/);
    expect(String(byName.get(SERVICE_POLICY)?.qual)).not.toMatch(/select\s+(auth\.)?role/i);
    expect(byName.get(USER_POLICY)?.qual).toMatch(/\buid\(\)/);
    expect(String(byName.get(USER_POLICY)?.qual)).not.toMatch(/select\s+(auth\.)?uid/i);
    expect(await probePlan(OWN_USER)).not.toContain('InitPlan');
  });

  test('wraps both auth calls so the plan evaluates them once, identities and semantics unchanged', async () => {
    await legacyFixture();
    await applyMigration();

    const byName = new Map((await policies()).map((p) => [p.policyname, p]));
    expect(byName.size).toBe(2);

    const service = byName.get(SERVICE_POLICY);
    expect(service?.cmd).toBe('ALL');
    expect(service?.permissive).toBe('PERMISSIVE');
    expect(service?.roles).toBe('{public}');
    expect(String(service?.qual)).toMatch(/select\s+(auth\.)?role\(\)/i);
    // Prod declares no WITH CHECK on this policy; the rewrite keeps it that way.
    expect(service?.with_check).toBeNull();

    const user = byName.get(USER_POLICY);
    expect(user?.cmd).toBe('SELECT');
    expect(user?.permissive).toBe('PERMISSIVE');
    expect(user?.roles).toBe('{public}');
    expect(String(user?.qual)).toMatch(/select\s+(auth\.)?uid\(\)/i);

    const plan = await probePlan(OWN_USER);
    expect(plan).toContain('InitPlan');

    // Same rows the old policies allowed: the subject's own, the other
    // account's, and none without a subject.
    expect(await probeRowCount(OWN_USER)).toBe('1');
    expect(await probeRowCount(OTHER_USER)).toBe('1');
    expect(await probeRowCount()).toBe('0');

    // RLS itself stays on, and a second apply leaves the same two policies.
    expect(
      await scalar(
        `SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = 'audit_log'`,
      ),
    ).toBe('true');
    await applyMigration();
    expect(await policies()).toHaveLength(2);
    expect(await probePlan(OWN_USER)).toContain('InitPlan');
  });

  test('is a no-op where the legacy table does not exist (baseline databases)', async () => {
    await raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);

    await applyMigration();

    expect(await scalar(`SELECT to_regclass('${TABLE}') IS NULL`)).toBe('true');
  });

  test('never invents a policy on a table whose RLS runs with none', async () => {
    await raw(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await raw(`CREATE TABLE ${TABLE} (account_id uuid NOT NULL)`);
    await raw(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
    await raw(`GRANT SELECT ON ${TABLE} TO ${PROBE_ROLE}`);

    await applyMigration();

    expect(await policies()).toHaveLength(0);
    expect(await probeRowCount()).toBe('0');
  });
});
