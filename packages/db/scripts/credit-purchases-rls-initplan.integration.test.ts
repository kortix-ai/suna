import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { resolve } from 'node:path';

const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL ?? process.env.TEST_DATABASE_URL });
const services = ['Service role can manage all credit purchases', 'Service role manages credit purchases'];
const users = ['Users can view own credit purchases', 'Users can view their own credit purchases'];
const own = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
async function apply() {
  const directory = resolve(import.meta.dir, '../migrations');
  const names = Array.from(new Bun.Glob('*_credit_purchases_rls_initplan.sql').scanSync({ cwd: directory }));
  expect(names).toHaveLength(1);
  for (const name of names) await client.query(`BEGIN; ${await Bun.file(resolve(directory, name)).text()} COMMIT;`);
}
async function fixture() {
  await client.query(`DROP TABLE IF EXISTS public.credit_purchases; CREATE TABLE public.credit_purchases (account_id uuid); ALTER TABLE public.credit_purchases ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.credit_purchases VALUES ('${own}'), ('${other}'); GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_purchases TO purchases_probe;`);
  for (const name of services) await client.query(`CREATE POLICY "${name}" ON public.credit_purchases USING (auth.role() = 'service_role');`);
  for (const name of users) await client.query(`CREATE POLICY "${name}" ON public.credit_purchases FOR SELECT USING (auth.uid() = account_id);`);
}
async function probe(subject: string, role: string, sql = 'SELECT account_id FROM public.credit_purchases') {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE purchases_probe');
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [subject, role]);
    return await client.query(sql);
  } finally { await client.query('ROLLBACK'); }
}
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required: use a disposable database');
  await client.connect();
  await client.query(`CREATE ROLE purchases_probe NOLOGIN NOBYPASSRLS; CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
    GRANT USAGE ON SCHEMA public, auth TO purchases_probe;`);
});
afterAll(async () => {
  await client.query('DROP TABLE IF EXISTS public.credit_purchases; DROP OWNED BY purchases_probe; DROP ROLE purchases_probe;');
  await client.end();
});
test('all four policies gain InitPlans without changing row access or service writes', async () => {
  await fixture();
  expect(JSON.stringify((await probe(own, 'authenticated', 'EXPLAIN SELECT * FROM public.credit_purchases')).rows)).not.toContain('InitPlan');
  expect((await probe(own, 'authenticated')).rows).toEqual([{ account_id: own }]);
  await apply();
  const policies = await client.query("SELECT policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='credit_purchases'");
  expect(policies.rows).toHaveLength(4);
  for (const row of policies.rows) {
    expect(row.roles).toBe('{public}');
    expect(row.permissive).toBe('PERMISSIVE');
    expect(row.cmd).toBe(services.includes(row.policyname) ? 'ALL' : 'SELECT');
    expect(row.with_check).toBeNull();
    // pg_get_expr drops the schema prefix when auth is on search_path; the InitPlan assertion below proves the wrap.
    expect(row.qual.toLowerCase()).toMatch(/select (auth\.)?(role|uid)\(\)/);
  }
  expect(JSON.stringify((await probe(own, 'authenticated', 'EXPLAIN SELECT * FROM public.credit_purchases')).rows)).toContain('InitPlan');
  expect((await probe(own, 'authenticated')).rows).toEqual([{ account_id: own }]);
  expect((await probe(other, 'authenticated')).rows).toEqual([{ account_id: other }]);
  expect((await probe('', 'anon')).rows).toEqual([]);
  expect((await probe('', 'service_role')).rows).toHaveLength(2);
  expect((await probe('', 'service_role', `INSERT INTO public.credit_purchases VALUES ('${own}') RETURNING account_id`)).rowCount).toBe(1);
  expect((await probe('', 'service_role', 'UPDATE public.credit_purchases SET account_id=account_id RETURNING account_id')).rowCount).toBe(2);
  expect((await probe('', 'service_role', 'DELETE FROM public.credit_purchases RETURNING account_id')).rowCount).toBe(2);
  await expect(probe(own, 'authenticated', `INSERT INTO public.credit_purchases VALUES ('${own}')`)).rejects.toThrow();
  await apply();
});
test('missing table and missing policies remain absent', async () => {
  await client.query('DROP TABLE IF EXISTS public.credit_purchases');
  await apply();
  expect((await client.query("SELECT to_regclass('public.credit_purchases') AS relation")).rows).toEqual([{ relation: null }]);
  await fixture();
  for (const name of [...services, ...users]) await client.query(`DROP POLICY "${name}" ON public.credit_purchases`);
  await apply();
  expect((await client.query("SELECT * FROM pg_policies WHERE schemaname='public' AND tablename='credit_purchases'")).rows).toHaveLength(0);
});
