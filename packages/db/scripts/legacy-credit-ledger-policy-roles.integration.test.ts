import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const migrationPath = join(import.meta.dir, '../migrations/20261003053000000_legacy_credit_ledger_policy_roles.sql');

suite('legacy credit ledger policy roles', () => {
  let client: pg.Client;
  let migration: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    migration = await Bun.file(migrationPath).text();
  });

  afterAll(async () => {
    await client.end();
  });

  async function fixture() {
    await client.query(`
      BEGIN;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
        AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
        AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
      CREATE TABLE public.credit_ledger (account_id uuid, amount integer);
      ALTER TABLE public.credit_ledger ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "Service role manages ledger" ON public.credit_ledger
        USING (auth.role() = 'service_role');
      CREATE POLICY "Users can view own ledger" ON public.credit_ledger
        FOR SELECT USING (auth.uid() = account_id);
      GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
      GRANT ALL ON public.credit_ledger TO authenticated, anon, service_role;
      INSERT INTO public.credit_ledger VALUES
        ('00000000-0000-4000-8000-000000000001', 10),
        ('00000000-0000-4000-8000-000000000002', 20);
    `);
  }

  async function overlaps() {
    const result = await client.query(`
      SELECT count(*)::integer AS count FROM (
        SELECT r.rolname FROM pg_policies p CROSS JOIN pg_roles r
        WHERE p.schemaname = 'public' AND p.tablename = 'credit_ledger'
          AND p.permissive = 'PERMISSIVE' AND p.cmd IN ('ALL', 'SELECT')
          AND r.rolname IN ('anon', 'authenticated', 'service_role')
          AND ('public' = ANY(p.roles) OR r.rolname = ANY(p.roles))
        GROUP BY r.rolname HAVING count(*) > 1
      ) AS policy_overlaps
    `);
    return result.rows[0].count;
  }

  test('removes overlapping permissive SELECT policies, preserves predicates, and is idempotent', async () => {
    try {
      await fixture();
      expect(await overlaps()).toBe(3);
      const before = await client.query("SELECT policyname, qual, with_check, cmd FROM pg_policies WHERE schemaname='public' AND tablename='credit_ledger' ORDER BY policyname");
      await client.query(migration);
      expect(await overlaps()).toBe(0);
      const after = await client.query("SELECT policyname, qual, with_check, cmd FROM pg_policies WHERE schemaname='public' AND tablename='credit_ledger' ORDER BY policyname");
      expect(after.rows).toEqual(before.rows);
      await client.query(migration);
      expect(await overlaps()).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('members see only their ledger, anon sees nothing, and service role retains writes without BYPASSRLS', async () => {
    try {
      await fixture();
      await client.query(migration);
      await client.query(`SET LOCAL ROLE authenticated;
        SET LOCAL request.jwt.claim.role = 'authenticated';
        SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';`);
      expect((await client.query('SELECT amount FROM public.credit_ledger')).rows).toEqual([{ amount: 10 }]);
      await client.query("SET LOCAL request.jwt.claim.sub = '00000000-0000-4000-8000-000000000003'");
      expect((await client.query('SELECT amount FROM public.credit_ledger')).rows).toEqual([]);
      await client.query("RESET ROLE; SET LOCAL ROLE anon; SET LOCAL request.jwt.claim.role = 'anon'; SET LOCAL request.jwt.claim.sub = ''");
      expect((await client.query('SELECT amount FROM public.credit_ledger')).rows).toEqual([]);
      await client.query("RESET ROLE; SET LOCAL ROLE service_role; SET LOCAL request.jwt.claim.role = 'service_role'");
      expect((await client.query('SELECT amount FROM public.credit_ledger ORDER BY amount')).rows).toEqual([{ amount: 10 }, { amount: 20 }]);
      expect((await client.query('INSERT INTO public.credit_ledger (amount) VALUES (30) RETURNING amount')).rows).toEqual([{ amount: 30 }]);
      expect((await client.query('UPDATE public.credit_ledger SET amount = 40 WHERE amount = 30 RETURNING amount')).rows).toEqual([{ amount: 40 }]);
      expect((await client.query('DELETE FROM public.credit_ledger WHERE amount = 40 RETURNING amount')).rows).toEqual([{ amount: 40 }]);
    } finally {
      await client.query('RESET ROLE; ROLLBACK');
    }
  });

  test('is safe when the legacy table or either policy is absent', async () => {
    try {
      await client.query('BEGIN');
      expect((await client.query("SELECT to_regclass('public.credit_ledger') IS NULL AS absent")).rows).toEqual([{ absent: true }]);
      await client.query(migration);
      await client.query('ROLLBACK');
      await fixture();
      await client.query('DROP POLICY "Users can view own ledger" ON public.credit_ledger');
      await client.query(migration);
      expect(await overlaps()).toBe(0);
      await client.query('DROP POLICY "Service role manages ledger" ON public.credit_ledger');
      await client.query(migration);
      expect(await overlaps()).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
