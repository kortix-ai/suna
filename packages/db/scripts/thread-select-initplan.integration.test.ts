import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import pg from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL;
const migrationPath = resolve(
  import.meta.dir,
  '../migrations/20261003052000000_thread_select_auth_initplan.sql',
);

describe.skipIf(!databaseUrl)('legacy threads auth initplan', () => {
  test('preserves visibility and evaluates auth once per statement', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE SCHEMA IF NOT EXISTS basejump;
        CREATE SEQUENCE public.auth_calls;
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE plpgsql STABLE AS $$
        BEGIN
          PERFORM nextval('public.auth_calls');
          RETURN nullif(current_setting('test.user_id', true), '')::uuid;
        END $$;
        CREATE OR REPLACE FUNCTION basejump.has_role_on_account(uuid) RETURNS boolean
          LANGUAGE sql STABLE AS $$ SELECT $1::text = current_setting('test.account_id', true) $$;
        CREATE TYPE public.user_role AS ENUM ('member', 'admin', 'super_admin');
        CREATE TABLE public.user_roles(user_id uuid, role public.user_role);
        CREATE TABLE public.projects(project_id integer, account_id uuid, is_public boolean);
        CREATE TABLE public.threads(thread_id integer, account_id uuid, project_id integer, is_public boolean);
        ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
        CREATE POLICY thread_select_policy ON public.threads FOR SELECT USING (
          is_public IS TRUE OR basejump.has_role_on_account(account_id) = true OR
          EXISTS (SELECT 1 FROM public.projects WHERE projects.project_id = threads.project_id AND
            (projects.is_public IS TRUE OR basejump.has_role_on_account(projects.account_id) = true)) OR
          EXISTS (SELECT 1 FROM public.user_roles WHERE user_roles.user_id = auth.uid() AND
            user_roles.role = ANY (ARRAY['admin'::public.user_role, 'super_admin'::public.user_role])));
        CREATE ROLE threads_reader;
        GRANT USAGE ON SCHEMA auth, basejump TO threads_reader;
        GRANT SELECT ON public.threads, public.projects, public.user_roles TO threads_reader;
        GRANT USAGE ON SEQUENCE public.auth_calls TO threads_reader;
        INSERT INTO public.user_roles VALUES
          ('00000000-0000-0000-0000-000000000001', 'admin'),
          ('00000000-0000-0000-0000-000000000003', 'super_admin'),
          ('00000000-0000-0000-0000-000000000004', 'member');
        INSERT INTO public.projects VALUES
          (1, '00000000-0000-0000-0000-000000000002', true),
          (2, '00000000-0000-0000-0000-000000000005', false);
        INSERT INTO public.threads SELECT n, '00000000-0000-0000-0000-000000000002',
          CASE WHEN n = 2 THEN 1 WHEN n = 3 THEN 2 END, n = 1 FROM generate_series(1, 20) n;
      `);
      const migration = await Bun.file(migrationPath).text();
      await client.query(migration);
      await client.query(migration);
      await client.query('SET LOCAL ROLE threads_reader');
      await client.query(
        "SELECT set_config('test.user_id', '00000000-0000-0000-0000-000000000001', true)",
      );
      expect((await client.query('SELECT thread_id FROM public.threads')).rowCount).toBe(20);
      await client.query('RESET ROLE');
      expect((await client.query('SELECT last_value FROM public.auth_calls')).rows).toEqual([
        { last_value: '1' },
      ]);
      await client.query('SET LOCAL ROLE threads_reader');
      await client.query("SELECT set_config('test.user_id', '', true)");
      expect(
        (await client.query('SELECT thread_id FROM public.threads ORDER BY thread_id')).rows,
      ).toEqual([{ thread_id: 1 }, { thread_id: 2 }]);
      await client.query(
        "SELECT set_config('test.user_id', '00000000-0000-0000-0000-000000000004', true)",
      );
      expect(
        (await client.query('SELECT thread_id FROM public.threads ORDER BY thread_id')).rows,
      ).toEqual([{ thread_id: 1 }, { thread_id: 2 }]);
      await client.query(
        "SELECT set_config('test.account_id', '00000000-0000-0000-0000-000000000005', true)",
      );
      expect(
        (await client.query('SELECT thread_id FROM public.threads ORDER BY thread_id')).rows,
      ).toEqual([{ thread_id: 1 }, { thread_id: 2 }, { thread_id: 3 }]);
      await client.query("SELECT set_config('test.account_id', '', true)");
      await client.query(
        "SELECT set_config('test.user_id', '00000000-0000-0000-0000-000000000003', true)",
      );
      expect((await client.query('SELECT thread_id FROM public.threads')).rowCount).toBe(20);
      await client.query("SELECT set_config('test.user_id', '', true)");
      await client.query(
        "SELECT set_config('test.account_id', '00000000-0000-0000-0000-000000000002', true)",
      );
      expect((await client.query('SELECT thread_id FROM public.threads')).rowCount).toBe(20);
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  test('is a no-op when the legacy table is absent', async () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query(await Bun.file(migrationPath).text());
      expect((await client.query("SELECT to_regclass('public.threads') AS relation")).rows).toEqual(
        [{ relation: null }],
      );
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });
});
