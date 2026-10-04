import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.TEST_DATABASE_SUPERUSER_URL;
if (!url) throw new Error('TEST_DATABASE_SUPERUSER_URL is required');
const client = new pg.Client({ connectionString: url });
let migration = '';

beforeAll(async () => {
  await client.connect();
  // pg_policies omits a schema that is on search_path; pin it so `auth.` prints.
  await client.query('SET search_path TO public');
  const names = Array.from(new Bun.Glob('*_user_roles_rls_initplan.sql').scanSync({
    cwd: join(import.meta.dir, '..', 'migrations'),
  }));
  expect(names).toHaveLength(1);
  const name = names[0];
  if (!name) throw new Error('Migration missing');
  migration = await Bun.file(join(import.meta.dir, '..', 'migrations', name)).text();
});
afterAll(async () => { await client.end(); });

test('legacy policies gain InitPlans without changing access; absent objects and replay are safe', async () => {
  await client.query('BEGIN');
  try {
    await client.query('DROP TABLE IF EXISTS public.user_roles CASCADE');
    await client.query(migration);
    const absent = await client.query("SELECT to_regclass('public.user_roles') AS table_name");
    expect(absent.rows[0].table_name).toBeNull();
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      GRANT USAGE ON SCHEMA auth TO authenticated;
      CREATE TABLE public.user_roles (user_id uuid PRIMARY KEY, role text);
      ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "Service role can manage all roles" ON public.user_roles
        USING (auth.role() = 'service_role'::text);
      CREATE POLICY "Users can view their own role" ON public.user_roles FOR SELECT
        USING (auth.uid() = user_id);
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated;
      INSERT INTO public.user_roles VALUES
        ('11111111-1111-4111-8111-111111111111', 'first'),
        ('22222222-2222-4222-8222-222222222222', 'second');
    `);
    const visible = async (role: string, sub: string) => {
      await client.query('SET LOCAL ROLE authenticated');
      await client.query("SELECT set_config('request.jwt.claim.role', $1, true), set_config('request.jwt.claim.sub', $2, true)", [role, sub]);
      const rows = await client.query('SELECT role FROM public.user_roles ORDER BY role');
      await client.query('RESET ROLE');
      return rows.rows;
    };
    const user = '11111111-1111-4111-8111-111111111111';
    expect(await visible('authenticated', user)).toEqual([{ role: 'first' }]);
    expect(await visible('service_role', user)).toEqual([{ role: 'first' }, { role: 'second' }]);
    const flagged = () => client.query(`SELECT policyname FROM pg_policies
      WHERE schemaname='public' AND tablename='user_roles'
      AND ((qual LIKE '%auth.role()%' AND lower(qual) NOT LIKE '%select auth.role()%')
        OR (qual LIKE '%auth.uid()%' AND lower(qual) NOT LIKE '%select auth.uid()%'))`);
    expect((await flagged()).rowCount).toBe(2);
    await client.query(migration);
    expect((await flagged()).rowCount).toBe(0);
    const shape = await client.query(`SELECT policyname, cmd, roles::text, permissive, with_check
      FROM pg_policies WHERE schemaname='public' AND tablename='user_roles' ORDER BY policyname`);
    expect(shape.rows).toEqual([
      { policyname: 'Service role can manage all roles', cmd: 'ALL', roles: '{public}', permissive: 'PERMISSIVE', with_check: null },
      { policyname: 'Users can view their own role', cmd: 'SELECT', roles: '{public}', permissive: 'PERMISSIVE', with_check: null },
    ]);
    expect(await visible('authenticated', user)).toEqual([{ role: 'first' }]);
    expect(await visible('service_role', user)).toEqual([{ role: 'first' }, { role: 'second' }]);
    await client.query('SET LOCAL ROLE authenticated');
    await client.query("SELECT set_config('request.jwt.claim.role', 'authenticated', true)");
    expect((await client.query("UPDATE public.user_roles SET role='denied'")).rowCount).toBe(0);
    await client.query('SAVEPOINT denied_insert');
    await expect(client.query("INSERT INTO public.user_roles VALUES ('33333333-3333-4333-8333-333333333333', 'denied')")).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK TO SAVEPOINT denied_insert');
    await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)");
    expect((await client.query("UPDATE public.user_roles SET role=role")).rowCount).toBe(2);
    await client.query("INSERT INTO public.user_roles VALUES ('33333333-3333-4333-8333-333333333333', 'allowed')");
    expect((await client.query("DELETE FROM public.user_roles WHERE role='allowed'")).rowCount).toBe(1);
    const plan = await client.query('EXPLAIN (FORMAT JSON) SELECT * FROM public.user_roles');
    expect(JSON.stringify(plan.rows)).toContain('InitPlan');
    await client.query('RESET ROLE');
    await client.query(migration);
    expect((await flagged()).rowCount).toBe(0);
    await client.query('DROP POLICY "Users can view their own role" ON public.user_roles');
    await client.query(migration);
    expect((await flagged()).rowCount).toBe(0);
    await client.query('DROP POLICY "Service role can manage all roles" ON public.user_roles');
    await client.query(migration);
    expect((await flagged()).rowCount).toBe(0);
  } finally { await client.query('ROLLBACK'); }
});
