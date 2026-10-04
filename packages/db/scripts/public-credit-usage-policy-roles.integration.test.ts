/**
 * The `multiple_permissive_policies` fix for the legacy `public.credit_usage`,
 * against a real PostgreSQL. The fixture rebuilds the prod state KRTX-1140
 * (20261002214601090) left behind — both policies `roles={public}`, auth calls
 * wrapped — and proves the advisor's overlap rule counts three roles before
 * the migration and zero after, with predicates and access unchanged.
 *
 * The overlap count covers anon, authenticated and service_role directly, so
 * it does not depend on the image's role attributes (the hosted lint also
 * drops rolbypassrls roles, and current Supabase images mark service_role
 * BYPASSRLS). Run against the lane's fresh migrated database (TEST_DATABASE_URL).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const migrationPath = join(
  import.meta.dir,
  '../migrations/20261004002924533_public_credit_usage_policy_roles.sql',
);

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';

suite('public.credit_usage policy roles migration — real PostgreSQL', () => {
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

  /** The legacy prod shape the advisor flagged: both policies roles={public}. */
  async function fixture() {
    await client.query(`
      BEGIN;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
        AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
        AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
      DROP TABLE IF EXISTS public.credit_usage;
      CREATE TABLE public.credit_usage (
        id uuid primary key default gen_random_uuid(),
        account_id uuid not null,
        amount_dollars numeric(10,2) not null,
        description text
      );
      ALTER TABLE public.credit_usage ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "Users can view their own credit usage" ON public.credit_usage
        FOR SELECT USING ((select auth.uid()) = account_id);
      CREATE POLICY "Service role can manage all credit usage" ON public.credit_usage
        USING ((select auth.role()) = 'service_role'::text);
      GRANT SELECT ON public.credit_usage TO anon, authenticated;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_usage TO service_role;
      INSERT INTO public.credit_usage (account_id, amount_dollars, description) VALUES
        ('${ACCOUNT_A}', 1.00, 'acct-a'),
        ('${ACCOUNT_A}', 2.00, 'acct-a-2'),
        ('${ACCOUNT_B}', 3.00, 'acct-b');
    `);
  }

  /** supabase/splinter lints/0006's rule: permissive ALL/SELECT policies per
   *  role on this table; more than one per role is the advisor finding. */
  async function overlaps() {
    const result = await client.query(`
      SELECT count(*)::integer AS count FROM (
        SELECT r.rolname FROM pg_policies p CROSS JOIN pg_roles r
        WHERE p.schemaname = 'public' AND p.tablename = 'credit_usage'
          AND p.permissive = 'PERMISSIVE' AND p.cmd IN ('ALL', 'SELECT')
          AND r.rolname IN ('anon', 'authenticated', 'service_role')
          AND ('public' = ANY(p.roles) OR r.rolname = ANY(p.roles))
        GROUP BY r.rolname HAVING count(*) > 1
      ) AS policy_overlaps
    `);
    return result.rows[0].count;
  }

  async function policyShape() {
    const { rows } = await client.query(
      "SELECT policyname, cmd, permissive, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='credit_usage' ORDER BY policyname",
    );
    return rows;
  }

  async function policyRoles() {
    const { rows } = await client.query(
      "SELECT roles::text FROM pg_policies WHERE schemaname='public' AND tablename='credit_usage' ORDER BY policyname",
    );
    return rows.map((row) => row.roles);
  }

  async function seen(): Promise<string | null> {
    const { rows } = await client.query(
      "SELECT string_agg(description, ',') AS seen FROM public.credit_usage",
    );
    return rows[0]?.seen ?? null;
  }

  test('scopes the overlapping policies, preserves predicates, and is idempotent', async () => {
    try {
      await fixture();
      expect(await overlaps()).toBe(3);
      const before = await policyShape();
      await client.query(migration);
      expect(await overlaps()).toBe(0);
      expect(await policyShape()).toEqual(before);
      expect(await policyRoles()).toEqual(['{service_role}', '{authenticated}']);
      await client.query(migration);
      expect(await overlaps()).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('row visibility and write access are unchanged by the scoping', async () => {
    try {
      await fixture();
      await client.query(migration);
      await client.query(
        `SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '${ACCOUNT_A}'; SET LOCAL request.jwt.claim.role = 'authenticated'`,
      );
      expect(await seen()).toBe('acct-a,acct-a-2');
      await client.query(`SET LOCAL request.jwt.claim.sub = '${ACCOUNT_B}'`);
      expect(await seen()).toBe('acct-b');
      await client.query(
        `RESET ROLE; SET LOCAL ROLE anon; SET LOCAL request.jwt.claim.role = 'anon'; SET LOCAL request.jwt.claim.sub = ''`,
      );
      expect(await seen()).toBe(null);
      await client.query(
        `RESET ROLE; SET LOCAL ROLE service_role; SET LOCAL request.jwt.claim.role = 'service_role'`,
      );
      expect(
        (
          await client.query(
            `INSERT INTO public.credit_usage (account_id, amount_dollars, description) VALUES ('${ACCOUNT_B}', 9.00, 'svc-write-probe') RETURNING description`,
          )
        ).rows,
      ).toEqual([{ description: 'svc-write-probe' }]);
      await client.query(`DELETE FROM public.credit_usage WHERE description = 'svc-write-probe'`);
      // A user still has no write grant and the user policy is SELECT-only.
      // This aborts the transaction; the finally's ROLLBACK cleans it up.
      await expect(
        client.query(
          `SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub = '${ACCOUNT_A}';
           INSERT INTO public.credit_usage (account_id, amount_dollars, description) VALUES ('${ACCOUNT_A}', 5.00, 'user-write-probe')`,
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  test('is safe when the legacy table or either policy is absent', async () => {
    try {
      await client.query('BEGIN');
      await fixture();
      await client.query('DROP TABLE public.credit_usage');
      await client.query(migration);
      await client.query('ROLLBACK');
      await fixture();
      await client.query(
        'DROP POLICY "Users can view their own credit usage" ON public.credit_usage',
      );
      await client.query(migration);
      expect(await overlaps()).toBe(0);
      await client.query(
        'DROP POLICY "Service role can manage all credit usage" ON public.credit_usage',
      );
      await client.query(migration);
      expect(await overlaps()).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
