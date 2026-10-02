import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Regression test for the Supabase performance advisor lint
 * `auth_rls_initplan` on `public.api_keys` (KRTX-1133).
 *
 * `public.api_keys` is a legacy table from the pre-monorepo database. It is
 * created by neither the baseline nor 0000_bootstrap, so on a fresh database
 * the fix migration is a guarded no-op. On the long-lived databases the table
 * carries the RLS policy "Users can manage their own API keys", which called
 * `auth.uid()` bare — Postgres re-evaluated it for every row instead of
 * planning it once per statement, which is what the advisor flags.
 *
 * This suite rebuilds the legacy state on the lane's migrated database and
 * asserts, in order:
 *   1. the fix migration is a guarded no-op on the fresh-install shape,
 *   2. the advisor's own rule (supabase/splinter 0003_auth_rls_initplan, the
 *      `auth.uid()` branch) flags the legacy policy — the finding reproduced,
 *   3. after the committed migration file applies, the rule no longer flags
 *      it and the policy keeps its shape (RLS enabled, ALL + USING only, no
 *      separate WITH CHECK),
 *   4. row access is unchanged: a member of account A sees and writes only
 *      account A's keys, and cannot touch account B's. The lane role owns the
 *      table (as prod's API role does), so FORCE RLS puts it under the policy.
 *
 * Fixture DDL runs through TEST_DATABASE_SUPERUSER_URL because the lane role
 * cannot create objects in the public schema; the suite then reassigns the
 * table to the lane role so the migration and the RLS checks run as the role
 * prod's migration runner runs as.
 */

const laneUrl = process.env.TEST_DATABASE_URL;
const superuserUrl = process.env.TEST_DATABASE_SUPERUSER_URL;

if (!laneUrl) throw new Error('TEST_DATABASE_URL is not set');
if (!superuserUrl) throw new Error('TEST_DATABASE_SUPERUSER_URL is not set');

const MIGRATION_GLOB = '*_wrap_api_keys_rls_auth_initplan.sql';

/** The advisor's `auth_rls_initplan` rule for auth.uid(), scoped to the table under test. */
const LINTER_FINDS_BARE_AUTH_UID = `
  SELECT policyname FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'api_keys'
    AND policyname = 'Users can manage their own API keys'
    AND qual LIKE '%auth.uid()%'
    AND lower(qual) NOT LIKE '%select auth.uid()%'
`;

/** The legacy policy exactly as prod carries it (pg_policies.qual, re-written as SQL). */
const LEGACY_POLICY_SQL = `
  CREATE POLICY "Users can manage their own API keys" ON public.api_keys
    USING (
      account_id IN (
        SELECT wu.account_id
        FROM basejump.account_user wu
        WHERE wu.user_id = auth.uid()
      )
    )
`;

const LEGACY_TABLE_SQL = `
  CREATE TABLE public.api_keys (
    key_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    public_key varchar(64) NOT NULL,
    secret_key_hash varchar(64) NOT NULL,
    account_id uuid NOT NULL,
    title varchar(255) NOT NULL,
    description text,
    status text DEFAULT 'active',
    expires_at timestamptz,
    last_used_at timestamptz,
    created_at timestamptz DEFAULT now()
  )
`;

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let migrationSql: string;
let laneRole: string;

/** The PostgreSQL error code of a driver error, or undefined. Same shape as migration-retry.ts. */
function pgErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown };
  return typeof value.code === 'string' ? value.code : undefined;
}

async function withClient(url: string, fn: (client: pg.Client) => Promise<void>): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

describe('api_keys RLS auth_rls_initplan migration', () => {
  beforeAll(async () => {
    const migrationNames = Array.from(
      new Bun.Glob(MIGRATION_GLOB).scanSync({ cwd: join(import.meta.dir, '..', 'migrations') }),
    );
    expect(migrationNames).toHaveLength(1);
    migrationSql = readFileSync(
      join(import.meta.dir, '..', 'migrations', migrationNames[0]),
      'utf8',
    );
    await withClient(laneUrl, async (client) => {
      const who = await client.query<{ role: string }>('SELECT current_user AS role');
      laneRole = who.rows[0].role;
    });
  });

  afterAll(async () => {
    await withClient(superuserUrl, async (admin) => {
      await admin.query('DROP TABLE IF EXISTS public.api_keys CASCADE');
      await admin.query(`DELETE FROM basejump.account_user WHERE user_id IN ($1, $2)`, [
        USER_A,
        USER_B,
      ]);
    });
  });

  test('fresh-install shape: the migration is a guarded no-op (no legacy table)', async () => {
    await withClient(laneUrl, async (client) => {
      // The lane database is a fresh install shape: the legacy table must not
      // pre-exist, or this suite would be testing a state prod is not in.
      const preexisting = await client.query(
        `SELECT to_regclass('public.api_keys') IS NOT NULL AS present`,
      );
      expect(preexisting.rows[0].present).toBe(false);

      await client.query(migrationSql);
      const created = await client.query(
        `SELECT to_regclass('public.api_keys') IS NOT NULL AS present`,
      );
      expect(created.rows[0].present).toBe(false);
      const policies = await client.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'api_keys'`,
      );
      expect(policies.rowCount).toBe(0);
    });
  });

  describe('with the legacy state present', () => {
    beforeAll(async () => {
      // The lane role cannot create objects in the public schema, so the
      // fixture DDL runs as the superuser; the table then moves to the lane
      // role, which is the role prod's migration runner runs as.
      await withClient(superuserUrl, async (admin) => {
        await admin.query(
          `INSERT INTO basejump.account_user (user_id, account_id, account_role)
           VALUES ($1, $3, 'owner'), ($2, $4, 'owner')`,
          [USER_A, USER_B, ACCOUNT_A, ACCOUNT_B],
        );
        // The legacy policy's subquery reads basejump.account_user and calls
        // auth.uid() as the querying role, exactly as it does for an
        // authenticated client. Prod grants USAGE on basejump and auth to
        // postgres and authenticated; the lane's superuser-created stubs (and
        // the --no-privileges auth dump) carry no such grant, so mirror prod
        // here for both schemas.
        await admin.query('GRANT USAGE ON SCHEMA basejump TO PUBLIC');
        await admin.query('GRANT SELECT ON basejump.account_user TO PUBLIC');
        await admin.query(`GRANT USAGE ON SCHEMA auth TO ${laneRole}`);
        await admin.query(LEGACY_TABLE_SQL);
        await admin.query('ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY');
        await admin.query(LEGACY_POLICY_SQL);
        // Superuser inserts bypass RLS; prod's rows were written by its API role.
        await admin.query(
          `INSERT INTO public.api_keys (public_key, secret_key_hash, account_id, title)
           VALUES
             (repeat('a', 64), repeat('h', 64), $1, 'account A key'),
             (repeat('b', 64), repeat('h', 64), $2, 'account B key')`,
          [ACCOUNT_A, ACCOUNT_B],
        );
        await admin.query(`ALTER TABLE public.api_keys OWNER TO ${laneRole}`);
      });
    });

    test('the legacy policy re-evaluates auth.uid() per row (the advisor finding)', async () => {
      await withClient(laneUrl, async (client) => {
        const flagged = await client.query(LINTER_FINDS_BARE_AUTH_UID);
        expect(flagged.rowCount).toBe(1);
      });
    });

    test('the migration replaces it with the initplan form and preserves the policy shape', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query(migrationSql);

        const flagged = await client.query(LINTER_FINDS_BARE_AUTH_UID);
        expect(flagged.rowCount).toBe(0);

        const row = await client.query<{ qual: string; with_check: string | null }>(
          `SELECT qual, with_check FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'api_keys'
             AND policyname = 'Users can manage their own API keys'`,
        );
        expect(row.rowCount).toBe(1);
        expect(row.rows[0].qual).toContain('( SELECT auth.uid()');
        expect(row.rows[0].with_check).toBeNull();

        const rls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'api_keys'`,
        );
        expect(rls.rows[0].relrowsecurity).toBe(true);
        expect(rls.rows[0].relforcerowsecurity).toBe(false);
      });
    });

    test('row access is unchanged: a member sees and writes only their own account', async () => {
      await withClient(laneUrl, async (client) => {
        // The lane role owns the table, so FORCE RLS makes the policy apply
        // to it too — the same rows an authenticated client would see.
        await client.query('ALTER TABLE public.api_keys FORCE ROW LEVEL SECURITY');
        try {
          await client.query('BEGIN');
          await client.query(`SET LOCAL request.jwt.claim.sub = '${USER_A}'`);

          const visible = await client.query<{ account_id: string; title: string }>(
            `SELECT account_id::text, title FROM public.api_keys`,
          );
          expect(visible.rowCount).toBe(1);
          expect(visible.rows[0].account_id).toBe(ACCOUNT_A);
          expect(visible.rows[0].title).toBe('account A key');

          const insertOwn = await client.query<{ account_id: string }>(
            `INSERT INTO public.api_keys (public_key, secret_key_hash, account_id, title)
             VALUES (repeat('c', 64), repeat('h', 64), $1, 'own insert') RETURNING account_id::text`,
            [ACCOUNT_A],
          );
          expect(insertOwn.rows[0].account_id).toBe(ACCOUNT_A);

          let rejected = false;
          try {
            await client.query(
              `INSERT INTO public.api_keys (public_key, secret_key_hash, account_id, title)
               VALUES (repeat('d', 64), repeat('h', 64), $1, 'foreign insert')`,
              [ACCOUNT_B],
            );
          } catch (error) {
            rejected = pgErrorCode(error) === '42501';
          }
          expect(rejected).toBe(true);
          // The failed insert left the transaction aborted; roll it back.
          await client.query('ROLLBACK');

          await client.query('BEGIN');
          await client.query(`SET LOCAL request.jwt.claim.sub = '${USER_B}'`);
          const visibleB = await client.query<{ account_id: string }>(
            `SELECT account_id::text FROM public.api_keys`,
          );
          expect(visibleB.rowCount).toBe(1);
          expect(visibleB.rows[0].account_id).toBe(ACCOUNT_B);
          await client.query('ROLLBACK');
        } finally {
          await client.query('ALTER TABLE public.api_keys NO FORCE ROW LEVEL SECURITY');
        }
      });
    });
  });
});
