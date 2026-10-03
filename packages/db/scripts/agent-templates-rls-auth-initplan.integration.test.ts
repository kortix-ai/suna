import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const client = new pg.Client({ connectionString: url });
const migrationPath = join(
  import.meta.dir,
  '../migrations/20261003223000000_agent_templates_auth_initplan.sql',
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

beforeEach(async () => {
  await client.connect();
  await client.query('BEGIN');
  const existing = await client.query("SELECT to_regclass('public.agent_templates') AS relation");
  expect(existing.rows[0].relation).toBeNull();
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    CREATE TABLE public.agent_templates (id int PRIMARY KEY, creator_id uuid, is_public boolean);
    INSERT INTO public.agent_templates VALUES
      (1, '${owner}', false), (2, '${other}', false), (3, '${other}', true), (4, NULL, false);
    ALTER TABLE public.agent_templates ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.agent_templates FORCE ROW LEVEL SECURITY;
    CREATE POLICY "Users can create their own templates" ON public.agent_templates
      FOR INSERT WITH CHECK (creator_id = (auth.jwt() ->> 'sub')::uuid);
    CREATE POLICY "Users can delete their own templates" ON public.agent_templates
      FOR DELETE USING (creator_id = (auth.jwt() ->> 'sub')::uuid);
    CREATE POLICY "Users can update their own templates" ON public.agent_templates
      FOR UPDATE USING (creator_id = (auth.jwt() ->> 'sub')::uuid)
      WITH CHECK (creator_id = (auth.jwt() ->> 'sub')::uuid);
    CREATE POLICY "Users can view public templates or their own templates" ON public.agent_templates
      FOR SELECT USING (is_public = true OR creator_id = (auth.jwt() ->> 'sub')::uuid);
    CREATE POLICY untouched ON public.agent_templates AS RESTRICTIVE FOR SELECT USING (true);
  `);
});

afterEach(async () => {
  await client.query('ROLLBACK');
  await client.end();
});

test('legacy template policies use InitPlans without changing access or sibling policies', async () => {
  const migration = readFileSync(migrationPath, 'utf8');
  const before = await client.query(`SELECT policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_templates' ORDER BY policyname`);
  await client.query(migration);
  await client.query(migration);
  const after = await client.query(`SELECT policyname, permissive, roles, cmd, qual, with_check
    FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_templates' ORDER BY policyname`);
  expect(
    after.rows.map(({ policyname, permissive, roles, cmd }) => ({
      policyname,
      permissive,
      roles,
      cmd,
    })),
  ).toEqual(
    before.rows.map(({ policyname, permissive, roles, cmd }) => ({
      policyname,
      permissive,
      roles,
      cmd,
    })),
  );
  expect(after.rows.find((row) => row.policyname === 'untouched')).toEqual(
    before.rows.find((row) => row.policyname === 'untouched'),
  );
  for (const row of after.rows.filter((row) => row.policyname !== 'untouched')) {
    const beforeRow = before.rows.find((b) => b.policyname === row.policyname);
    // ALTER POLICY replaces only the clauses it is given: assert no clause was
    // dropped and every remaining one is InitPlan'd, so no per-row auth call
    // survives in qual or with_check.
    expect(!!row.qual).toBe(!!beforeRow.qual);
    expect(!!row.with_check).toBe(!!beforeRow.with_check);
    if (row.qual) expect(row.qual).toContain('SELECT auth.jwt()');
    if (row.with_check) expect(row.with_check).toContain('SELECT auth.jwt()');
  }
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: owner }),
  ]);
  const plan = await client.query('EXPLAIN (FORMAT JSON) SELECT * FROM public.agent_templates');
  expect(JSON.stringify(plan.rows)).toContain('InitPlan');
  expect((await client.query('SELECT id FROM public.agent_templates ORDER BY id')).rows).toEqual([
    { id: 1 },
    { id: 3 },
  ]);
  await client.query('INSERT INTO public.agent_templates VALUES (5, $1, false)', [owner]);
  expect(
    (
      await client.query(
        'UPDATE public.agent_templates SET is_public = true WHERE id IN (1, 2, 3) RETURNING id',
      )
    ).rows,
  ).toEqual([{ id: 1 }]);
  await client.query('SAVEPOINT denied');
  await expect(
    client.query('INSERT INTO public.agent_templates VALUES (6, $1, false)', [other]),
  ).rejects.toThrow('row-level security');
  await client.query('ROLLBACK TO SAVEPOINT denied');
  await client.query('SAVEPOINT denied_update');
  await expect(
    client.query('UPDATE public.agent_templates SET creator_id = $1 WHERE id = 1', [other]),
  ).rejects.toThrow('row-level security');
  await client.query('ROLLBACK TO SAVEPOINT denied_update');
  expect(
    (await client.query('DELETE FROM public.agent_templates WHERE id IN (2, 3) RETURNING id')).rows,
  ).toEqual([]);
  expect(
    (await client.query('DELETE FROM public.agent_templates WHERE id = 5 RETURNING id')).rows,
  ).toEqual([{ id: 5 }]);
  await client.query("SELECT set_config('request.jwt.claims', '{}', true)");
  expect((await client.query('SELECT id FROM public.agent_templates ORDER BY id')).rows).toEqual([
    { id: 1 },
    { id: 3 },
  ]);
  expect((await client.query('DELETE FROM public.agent_templates RETURNING id')).rows).toEqual([]);
  await client.query(
    'DROP POLICY "Users can delete their own templates" ON public.agent_templates',
  );
  await client.query(migration);
  expect(
    (
      await client.query(`SELECT 1 FROM pg_policies WHERE tablename = 'agent_templates'
    AND policyname = 'Users can delete their own templates'`)
    ).rowCount,
  ).toBe(0);
  await client.query('DROP TABLE public.agent_templates');
  await client.query(migration);
  expect(
    (await client.query("SELECT to_regclass('public.agent_templates') AS relation")).rows[0]
      .relation,
  ).toBeNull();
});
