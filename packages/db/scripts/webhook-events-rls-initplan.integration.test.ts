import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { resolve } from 'node:path';

const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_SUPERUSER_URL ?? process.env.TEST_DATABASE_URL });
const policy = 'Service role full access on webhook_events';
const idA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const idB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
async function apply() {
  const directory = resolve(import.meta.dir, '../migrations');
  const names = Array.from(new Bun.Glob('*_webhook_events_rls_initplan.sql').scanSync({ cwd: directory }));
  expect(names).toHaveLength(1);
  for (const name of names) await client.query(`BEGIN; ${await Bun.file(resolve(directory, name)).text()} COMMIT;`);
}
async function fixture() {
  await client.query(`DROP TABLE IF EXISTS public.webhook_events; CREATE TABLE public.webhook_events (id uuid, event_id text); ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.webhook_events VALUES ('${idA}', 'evt_a'), ('${idB}', 'evt_b'); GRANT SELECT, INSERT, UPDATE, DELETE ON public.webhook_events TO webhook_probe;`);
  await client.query(`CREATE POLICY "${policy}" ON public.webhook_events USING (auth.role() = 'service_role');`);
}
async function probe(subject: string, role: string, sql = 'SELECT event_id FROM public.webhook_events') {
  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE webhook_probe');
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)", [subject, role]);
    return await client.query(sql);
  } finally { await client.query('ROLLBACK'); }
}
beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required: use a disposable database');
  await client.connect();
  await client.query(`CREATE ROLE webhook_probe NOLOGIN NOBYPASSRLS; CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
    GRANT USAGE ON SCHEMA public, auth TO webhook_probe;`);
});
afterAll(async () => {
  await client.query('DROP TABLE IF EXISTS public.webhook_events; DROP OWNED BY webhook_probe; DROP ROLE webhook_probe;');
  await client.end();
});
test('the legacy policy gains an InitPlan without changing row access or service writes', async () => {
  await fixture();
  expect(JSON.stringify((await probe(idA, 'service_role', 'EXPLAIN SELECT * FROM public.webhook_events')).rows)).not.toContain('InitPlan');
  expect((await probe(idA, 'service_role')).rows).toHaveLength(2);
  expect((await probe('', 'anon')).rows).toEqual([]);
  expect((await probe(idA, 'authenticated')).rows).toEqual([]);
  await apply();
  // pg_policies omits a schema that is on search_path; pin it so `auth.` prints.
  await client.query('SET search_path TO public');
  const policies = await client.query("SELECT policyname, cmd, permissive, roles::text, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='webhook_events'");
  expect(policies.rows).toHaveLength(1);
  expect(policies.rows[0]).toMatchObject({ policyname: policy, cmd: 'ALL', permissive: 'PERMISSIVE', roles: '{public}', with_check: null });
  // pg_get_expr drops the schema prefix when auth is on search_path; the InitPlan assertion below proves the wrap.
  expect(policies.rows[0].qual.toLowerCase()).toMatch(/select (auth\.)?role\(\)/);
  expect(JSON.stringify((await probe(idA, 'service_role', 'EXPLAIN SELECT * FROM public.webhook_events')).rows)).toContain('InitPlan');
  expect((await probe(idA, 'service_role')).rows).toHaveLength(2);
  expect((await probe('', 'anon')).rows).toEqual([]);
  expect((await probe(idA, 'authenticated')).rows).toEqual([]);
  expect((await probe('', 'service_role', `INSERT INTO public.webhook_events VALUES ('${idA}', 'evt_c') RETURNING event_id`)).rowCount).toBe(1);
  expect((await probe('', 'service_role', 'UPDATE public.webhook_events SET event_id=event_id RETURNING event_id')).rowCount).toBe(2);
  expect((await probe('', 'service_role', 'DELETE FROM public.webhook_events RETURNING event_id')).rowCount).toBe(2);
  await expect(probe(idA, 'authenticated', `INSERT INTO public.webhook_events VALUES ('${idA}', 'evt_d')`)).rejects.toThrow();
  await apply();
});
test('missing table and missing policy remain absent', async () => {
  await client.query('DROP TABLE IF EXISTS public.webhook_events');
  await apply();
  expect((await client.query("SELECT to_regclass('public.webhook_events') AS relation")).rows).toEqual([{ relation: null }]);
  await fixture();
  await client.query(`DROP POLICY "${policy}" ON public.webhook_events`);
  await apply();
  expect((await client.query("SELECT * FROM pg_policies WHERE schemaname='public' AND tablename='webhook_events'")).rows).toHaveLength(0);
});
