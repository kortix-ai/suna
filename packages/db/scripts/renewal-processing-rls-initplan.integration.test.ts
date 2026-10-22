import { afterAll, beforeAll, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const client = new pg.Client({
  connectionString: process.env.TEST_DATABASE_SUPERUSER_URL ?? process.env.TEST_DATABASE_URL,
});
const POLICY = 'Service role full access on renewal_processing';
const own = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
async function apply() {
  const directory = resolve(import.meta.dir, '../migrations');
  const names = Array.from(
    new Bun.Glob('*_renewal_processing_rls_initplan.sql').scanSync({ cwd: directory }),
  );
  expect(names).toHaveLength(1);
  for (const name of names)
    await client.query(`BEGIN; ${await Bun.file(resolve(directory, name)).text()} COMMIT;`);
}
// The exact legacy shape the Supabase advisor flagged (prod pg_policies, read
// only, 2026-10-04): cmd ALL, roles {public}, bare auth.role(), no WITH CHECK.
async function fixture() {
  await client.query(`DROP TABLE IF EXISTS public.renewal_processing; CREATE TABLE public.renewal_processing (account_id uuid); ALTER TABLE public.renewal_processing ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.renewal_processing VALUES ('${own}'), ('${other}'); GRANT SELECT, INSERT, UPDATE, DELETE ON public.renewal_processing TO renewal_probe;`);
  await client.query(
    `CREATE POLICY "${POLICY}" ON public.renewal_processing TO public USING (auth.role() = 'service_role');`,
  );
}
async function probe(
  subject: string,
  role: string,
  sql = 'SELECT account_id FROM public.renewal_processing',
) {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE renewal_probe');
    await client.query(
      "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)",
      [subject, role],
    );
    return await client.query(sql);
  } finally {
    await client.query('ROLLBACK');
  }
}
async function policyRow() {
  await client.query('SET search_path TO public');
  const rows = await client.query(
    "SELECT policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='renewal_processing'",
  );
  return rows.rows;
}
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error('TEST_DATABASE_URL is required: use a disposable database');
  await client.connect();
  await client.query(`CREATE ROLE renewal_probe NOLOGIN NOBYPASSRLS; CREATE SCHEMA IF NOT EXISTS auth;
    DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF; END $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
    GRANT USAGE ON SCHEMA public, auth TO renewal_probe;`);
});
afterAll(async () => {
  await client.query(
    'DROP TABLE IF EXISTS public.renewal_processing; DROP OWNED BY renewal_probe; DROP ROLE renewal_probe;',
  );
  await client.end();
});
test('the legacy policy gains an InitPlan without changing row access or service writes', async () => {
  await fixture();
  expect(
    JSON.stringify(
      (await probe(own, 'authenticated', 'EXPLAIN SELECT * FROM public.renewal_processing')).rows,
    ),
  ).not.toContain('InitPlan');
  expect((await probe(own, 'authenticated')).rows).toEqual([]);
  await apply();
  const policies = await policyRow();
  expect(policies).toHaveLength(1);
  expect(policies[0].roles).toBe('{public}');
  expect(policies[0].permissive).toBe('PERMISSIVE');
  expect(policies[0].cmd).toBe('ALL');
  expect(policies[0].with_check).toBeNull();
  // pg_get_expr drops the schema prefix when auth is on search_path; the InitPlan assertion below proves the wrap.
  expect(policies[0].qual.toLowerCase()).toMatch(/select (auth\.)?role\(\)/);
  expect(
    JSON.stringify(
      (await probe(own, 'authenticated', 'EXPLAIN SELECT * FROM public.renewal_processing')).rows,
    ),
  ).toContain('InitPlan');
  expect((await probe(own, 'authenticated')).rows).toEqual([]);
  expect((await probe('', 'service_role')).rows).toHaveLength(2);
  expect(
    (
      await probe(
        '',
        'service_role',
        `INSERT INTO public.renewal_processing VALUES ('${own}') RETURNING account_id`,
      )
    ).rowCount,
  ).toBe(1);
  expect(
    (
      await probe(
        '',
        'service_role',
        'UPDATE public.renewal_processing SET account_id=account_id RETURNING account_id',
      )
    ).rowCount,
  ).toBe(2);
  expect(
    (await probe('', 'service_role', 'DELETE FROM public.renewal_processing RETURNING account_id'))
      .rowCount,
  ).toBe(2);
  await expect(
    probe(own, 'authenticated', `INSERT INTO public.renewal_processing VALUES ('${own}')`),
  ).rejects.toThrow();
});
test('the baseline shape and a missing policy are left untouched', async () => {
  await client.query(`DROP TABLE IF EXISTS public.renewal_processing; CREATE TABLE public.renewal_processing (account_id uuid);
    ALTER TABLE public.renewal_processing ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "${POLICY}" ON public.renewal_processing TO service_role
      USING ((select auth.role()) = 'service_role'::text) WITH CHECK ((select auth.role()) = 'service_role'::text);`);
  const before = await policyRow();
  await apply();
  expect(await policyRow()).toEqual(before);
  await client.query(`DROP POLICY "${POLICY}" ON public.renewal_processing`);
  await apply();
  expect(await policyRow()).toEqual([]);
  await client.query('DROP TABLE IF EXISTS public.renewal_processing');
  await apply();
  expect(
    (await client.query("SELECT to_regclass('public.renewal_processing') AS relation")).rows,
  ).toEqual([{ relation: null }]);
});
