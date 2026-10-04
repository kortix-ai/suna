import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { resolve } from 'node:path';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? test : test.skip;
const client = new pg.Client({ connectionString: url });
const setup = new pg.Client({
  connectionString: process.env.TEST_DATABASE_SUPERUSER_URL ?? url,
});
const migrationPath = resolve(
  import.meta.dir,
  '../migrations/20261004003004704_credit_purchases_single_permissive_policy.sql',
);
const own = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const servicePolicy = 'Service role can manage all credit purchases';
const userPolicy = 'Users can view own credit purchases';

async function apply() {
  await client.query(await Bun.file(migrationPath).text());
}

/**
 * The advisor invariant (Supabase lint multiple_permissive_policies): per
 * role and action, at most one permissive policy may apply. Policy roles
 * match by membership, and ALL covers every action.
 */
async function permissiveViolations(): Promise<number> {
  const { rows } = await client.query(
    `WITH roles AS (
       SELECT oid, rolname FROM pg_roles
       WHERE rolname = ANY($1::text[]) AND NOT rolsuper AND NOT rolbypassrls
     ), pol AS (
       SELECT cmd, roles FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'credit_purchases'
         AND permissive = 'PERMISSIVE'
     ), applicable AS (
       SELECT r.rolname AS role, a.action
       FROM pol p CROSS JOIN roles r
       CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) a(action)
       WHERE (p.cmd = 'ALL' OR p.cmd = a.action)
         AND ('public' = ANY(p.roles)
              OR r.rolname = ANY(p.roles)
              OR EXISTS (SELECT 1 FROM pg_auth_members m
                         JOIN roles g ON g.oid = m.roleid
                         WHERE m.member = r.oid AND g.rolname = ANY(p.roles)))
     )
     SELECT count(*)::int AS violations
     FROM (SELECT role, action FROM applicable GROUP BY role, action HAVING count(*) > 1) g`,
    [['anon', 'authenticated', 'service_role']],
  );
  return rows[0].violations;
}

async function probe(subject: string, role: string, sql = 'SELECT account_id FROM public.credit_purchases') {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE purchases_probe');
    await client.query(
      "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)",
      [subject, role],
    );
    return await client.query(sql);
  } finally {
    await client.query('ROLLBACK');
  }
}

/** The prod table shape today: two identical service ALL policies and two identical user SELECT policies. */
async function fixture() {
  await client.query(`
    DROP TABLE IF EXISTS public.credit_purchases;
    CREATE TABLE public.credit_purchases (account_id uuid);
    ALTER TABLE public.credit_purchases ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.credit_purchases VALUES ('${own}'), ('${other}');
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_purchases
      TO anon, authenticated, service_role, purchases_probe;
    CREATE POLICY "Service role can manage all credit purchases" ON public.credit_purchases
      USING (( select auth.role()) = 'service_role'::text);
    CREATE POLICY "Service role manages credit purchases" ON public.credit_purchases
      USING (( select auth.role()) = 'service_role'::text);
    CREATE POLICY "Users can view own credit purchases" ON public.credit_purchases
      FOR SELECT USING (( select auth.uid()) = account_id);
    CREATE POLICY "Users can view their own credit purchases" ON public.credit_purchases
      FOR SELECT USING (( select auth.uid()) = account_id);
  `);
}

beforeAll(async () => {
  if (!url) return; // the suites below are registered as skipped
  await client.connect();
  await setup.connect();
  const { rows: me } = await client.query('SELECT current_user::text AS u');
  await setup.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'purchases_probe') THEN
        CREATE ROLE purchases_probe NOLOGIN NOBYPASSRLS;
      END IF;
    END $$;
  `);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await setup.query(
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
         CREATE ROLE ${role} NOLOGIN NOBYPASSRLS; END IF; END $$;`,
    );
  }
  await setup.query(`GRANT purchases_probe TO ${me[0].u}`);
  await setup.query('GRANT anon, authenticated, service_role TO purchases_probe');
  await setup.query('GRANT USAGE ON SCHEMA auth TO purchases_probe');
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
      AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
  `);
});

afterAll(async () => {
  if (!url) return; // nothing was connected
  await client.query('DROP TABLE IF EXISTS public.credit_purchases');
  await setup.query('DROP OWNED BY purchases_probe');
  await setup.query('DROP ROLE IF EXISTS purchases_probe');
  await client.end();
  await setup.end();
});

/** Access is identical before and after: users read their own rows, anon reads nothing, service manages everything. */
async function checkAccess() {
  expect((await probe(own, 'authenticated')).rows).toEqual([{ account_id: own }]);
  expect((await probe(other, 'authenticated')).rows).toEqual([{ account_id: other }]);
  expect((await probe('', 'anon')).rows).toEqual([]);
  expect((await probe('', 'service_role')).rows).toHaveLength(2);
  expect(
    (await probe('', 'service_role', `INSERT INTO public.credit_purchases VALUES ('${own}') RETURNING account_id`))
      .rowCount,
  ).toBe(1);
  expect(
    (await probe('', 'service_role', 'UPDATE public.credit_purchases SET account_id = account_id RETURNING account_id'))
      .rowCount,
  ).toBe(2);
  expect(
    (await probe('', 'service_role', 'DELETE FROM public.credit_purchases RETURNING account_id')).rowCount,
  ).toBe(2);
  await expect(probe(own, 'authenticated', `INSERT INTO public.credit_purchases VALUES ('${own}')`)).rejects.toThrow();
}

suite('legacy credit purchases collapse to one permissive policy per role and action', async () => {
  await fixture();

  // Characterization: access is correct before the change.
  await checkAccess();

  await apply();

  // The advisor finding is gone: one permissive policy per role and action.
  expect(await permissiveViolations()).toBe(0);
  await checkAccess();

  const { rows: policies } = await client.query(
    `SELECT policyname, cmd, roles::text AS roles FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'credit_purchases' ORDER BY policyname`,
  );
  expect(policies).toEqual([
    { policyname: servicePolicy, cmd: 'ALL', roles: '{service_role}' },
    { policyname: userPolicy, cmd: 'SELECT', roles: '{authenticated}' },
  ]);

  await apply();
  expect(await permissiveViolations()).toBe(0);
  expect(
    (await client.query(
      "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'credit_purchases'",
    )).rows[0].n,
  ).toBe(2);
});

suite('absent objects and unexpected shapes change nothing', async () => {
  await client.query('DROP TABLE IF EXISTS public.credit_purchases');
  await apply();
  expect((await client.query("SELECT to_regclass('public.credit_purchases') AS r")).rows).toEqual([{ r: null }]);

  // A survivor missing while its duplicate remains: the guard must not drop
  // the only remaining policy of its kind.
  await fixture();
  await client.query(`DROP POLICY "${servicePolicy}" ON public.credit_purchases`);
  await apply();
  expect(
    (await client.query(
      `SELECT count(*)::int AS n FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'credit_purchases'
         AND policyname = 'Service role manages credit purchases'`,
    )).rows[0].n,
  ).toBe(1);

  // One pair already collapsed (duplicates gone, survivors still PUBLIC):
  // the survivors are scoped, nothing else changes.
  await fixture();
  await client.query(
    `DROP POLICY "Service role manages credit purchases" ON public.credit_purchases;
     DROP POLICY "Users can view their own credit purchases" ON public.credit_purchases`,
  );
  await apply();
  expect(await permissiveViolations()).toBe(0);
  expect(
    (await client.query(
      "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'credit_purchases'",
    )).rows[0].n,
  ).toBe(2);
});
