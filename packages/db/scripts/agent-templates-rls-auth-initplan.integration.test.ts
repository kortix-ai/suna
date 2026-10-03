import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Regression test for the Supabase performance advisor lint
 * `auth_rls_initplan` on `public.agent_templates` (KRTX-1132).
 *
 * `public.agent_templates` is a legacy table from the pre-monorepo database.
 * Neither the baseline nor 0000_bootstrap creates it, so on a fresh database
 * the fix migration is a guarded no-op. On the long-lived databases the table
 * carries four policies whose expressions call `auth.jwt()` bare — Postgres
 * re-evaluated it for every row instead of planning it once per statement,
 * which is what the advisor flags.
 *
 * This suite rebuilds the legacy state on the lane's migrated database and
 * asserts, in order:
 *   1. the fix migration is a guarded no-op on the fresh-install shape,
 *   2. the advisor's own rule (supabase/splinter 0003_auth_rls_initplan, the
 *      `auth.jwt()` branch) flags all four legacy policies — the finding
 *      reproduced,
 *   3. after the committed migration file applies, the rule no longer flags
 *      any of them, every policy keeps its commands, roles, permissiveness
 *      and clause set, and a plain SELECT plans the JWT read as an InitPlan,
 *   4. row access is unchanged for an authenticated client: a creator sees
 *      and writes only their own rows plus public ones, a foreign creator's
 *      rows are invisible and unwritable, and the sibling restrictive policy
 *      survives untouched.
 *
 * Fixture DDL runs through TEST_DATABASE_SUPERUSER_URL because the lane role
 * cannot create objects in the public schema; the table then moves to the
 * lane role, which is the role prod's migration runner runs as. The
 * behavioral checks run as SET LOCAL ROLE authenticated because the lane
 * role has BYPASSRLS on some Supabase images and FORCE RLS does not stop it.
 */

const laneUrl = process.env.TEST_DATABASE_URL;
const superuserUrl = process.env.TEST_DATABASE_SUPERUSER_URL;

if (!laneUrl) throw new Error('TEST_DATABASE_URL is not set');
if (!superuserUrl) throw new Error('TEST_DATABASE_SUPERUSER_URL is not set');

const MIGRATION_GLOB = '*_agent_templates_auth_initplan.sql';

/** The advisor's `auth_rls_initplan` rule for auth.jwt(), scoped to the table under test. */
const LINTER_FINDS_BARE_AUTH_JWT = `
  SELECT policyname, 'qual' AS clause FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'agent_templates'
    AND qual LIKE '%auth.jwt()%' AND lower(qual) NOT LIKE '%select auth.jwt()%'
  UNION ALL
  SELECT policyname, 'with_check' AS clause FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'agent_templates'
    AND with_check LIKE '%auth.jwt()%' AND lower(with_check) NOT LIKE '%select auth.jwt()%'
`;

/** The legacy policies exactly as prod carries them (pg_policies.qual / with_check, re-written as SQL). */
const LEGACY_POLICIES_SQL = `
  CREATE POLICY "Users can create their own templates" ON public.agent_templates
    FOR INSERT WITH CHECK (creator_id = (auth.jwt() ->> 'sub')::uuid);
  CREATE POLICY "Users can delete their own templates" ON public.agent_templates
    FOR DELETE USING (creator_id = (auth.jwt() ->> 'sub')::uuid);
  CREATE POLICY "Users can update their own templates" ON public.agent_templates
    FOR UPDATE USING (creator_id = (auth.jwt() ->> 'sub')::uuid)
    WITH CHECK (creator_id = (auth.jwt() ->> 'sub')::uuid);
  CREATE POLICY "Users can view public templates or their own templates" ON public.agent_templates
    FOR SELECT USING (is_public = true OR creator_id = (auth.jwt() ->> 'sub')::uuid)
`;

const LEGACY_TABLE_SQL = `
  CREATE TABLE public.agent_templates (
    id int PRIMARY KEY,
    creator_id uuid,
    is_public boolean
  )
`;

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

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

describe('agent_templates RLS auth_rls_initplan migration', () => {
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
      await admin.query('DROP TABLE IF EXISTS public.agent_templates CASCADE');
    });
  });

  test('fresh-install shape: the migration is a guarded no-op (no legacy table)', async () => {
    await withClient(laneUrl, async (client) => {
      // The lane database is a fresh install shape: the legacy table must not
      // pre-exist, or this suite would be testing a state prod is not in.
      const preexisting = await client.query(
        `SELECT to_regclass('public.agent_templates') IS NOT NULL AS present`,
      );
      expect(preexisting.rows[0].present).toBe(false);

      await client.query(migrationSql);
      const created = await client.query(
        `SELECT to_regclass('public.agent_templates') IS NOT NULL AS present`,
      );
      expect(created.rows[0].present).toBe(false);
      const policies = await client.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_templates'`,
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
        await admin.query('CREATE SCHEMA IF NOT EXISTS auth');
        // The same body Supabase installs; the lane's auth dump may already
        // carry it, in which case CREATE OR REPLACE is a no-op.
        await admin.query(`
          CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
            $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$`);
        // The Supabase template already carries authenticated; a standalone
        // Postgres does not.
        await admin.query(`DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            CREATE ROLE authenticated NOLOGIN;
          END IF;
        END $$;`);
        await admin.query(LEGACY_TABLE_SQL);
        await admin.query('ALTER TABLE public.agent_templates ENABLE ROW LEVEL SECURITY');
        await admin.query('ALTER TABLE public.agent_templates FORCE ROW LEVEL SECURITY');
        await admin.query(LEGACY_POLICIES_SQL);
        await admin.query(`CREATE POLICY untouched ON public.agent_templates
          AS RESTRICTIVE FOR SELECT USING (true)`);
        await admin.query('GRANT ALL ON public.agent_templates TO authenticated');
        // Superuser inserts bypass RLS; prod's rows were written by its API role.
        await admin.query(
          `INSERT INTO public.agent_templates VALUES
             (1, '${OWNER}', false), (2, '${OTHER}', false), (3, '${OTHER}', true)`,
        );
        await admin.query(`ALTER TABLE public.agent_templates OWNER TO ${laneRole}`);
      });
    });

    test('every legacy policy re-evaluates auth.jwt() per row (the advisor finding)', async () => {
      await withClient(laneUrl, async (client) => {
        const flagged = await client.query(LINTER_FINDS_BARE_AUTH_JWT);
        // One flag per policy clause the advisor charges: three quals plus the
        // create and update policies' WITH CHECK — the write side the issue calls out.
        expect(flagged.rowCount).toBe(5);
      });
    });

    test('the migration initplans every clause and preserves the policy shape', async () => {
      await withClient(laneUrl, async (client) => {
        const shapeOf = `SELECT policyname, permissive, roles, cmd,
            qual IS NOT NULL AS has_qual, with_check IS NOT NULL AS has_check
          FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_templates'
          ORDER BY policyname`;
        const before = await client.query(shapeOf);
        await client.query(migrationSql);
        await client.query(migrationSql);
        const after = await client.query(shapeOf);
        // Running twice changes nothing: the migration is idempotent.
        expect(after.rows).toEqual(before.rows);
        // The sibling restrictive policy survives untouched.
        expect(after.rows.find((row) => row.policyname === 'untouched')).toEqual(
          before.rows.find((row) => row.policyname === 'untouched'),
        );

        const flagged = await client.query(LINTER_FINDS_BARE_AUTH_JWT);
        expect(flagged.rowCount).toBe(0);
      });
    });

    test('an authenticated SELECT plans the JWT read once (InitPlan), not per row', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query('BEGIN');
        await client.query(`SET LOCAL request.jwt.claims = '${JSON.stringify({ sub: OWNER })}'`);
        await client.query('SET LOCAL ROLE authenticated');
        const plan = await client.query(
          'EXPLAIN (FORMAT JSON) SELECT * FROM public.agent_templates',
        );
        expect(JSON.stringify(plan.rows)).toContain('InitPlan');
        await client.query('ROLLBACK');
      });
    });

    test('row access is unchanged: own rows plus public ones, foreign rows untouchable', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query('BEGIN');
        await client.query(`SET LOCAL request.jwt.claims = '${JSON.stringify({ sub: OWNER })}'`);
        await client.query('SET LOCAL ROLE authenticated');
        try {
          const visible = await client.query<{ id: number }>(
            'SELECT id FROM public.agent_templates ORDER BY id',
          );
          // Own row 1 and the public row 3; the foreign private row 2 stays hidden.
          expect(visible.rows).toEqual([{ id: 1 }, { id: 3 }]);

          const insertOwn = await client.query<{ id: number }>(
            'INSERT INTO public.agent_templates VALUES (5, $1, false) RETURNING id',
            [OWNER],
          );
          expect(insertOwn.rows).toEqual([{ id: 5 }]);

          // Each denied write is confined to a savepoint: the assertion is the
          // RLS violation, and the transaction stays usable after it.
          await client.query('SAVEPOINT denied');
          let rejected = false;
          try {
            await client.query('INSERT INTO public.agent_templates VALUES (6, $1, false)', [
              OTHER,
            ]);
          } catch (error) {
            rejected = pgErrorCode(error) === '42501';
          }
          expect(rejected).toBe(true);
          await client.query('ROLLBACK TO SAVEPOINT denied');

          const moved = await client.query<{ id: number }>(
            'UPDATE public.agent_templates SET is_public = true WHERE id IN (1, 2) RETURNING id',
          );
          // Row 2 belongs to a foreign creator: invisible, so only row 1 moves.
          expect(moved.rows).toEqual([{ id: 1 }]);

          await client.query('SAVEPOINT denied_update');
          rejected = false;
          try {
            await client.query('UPDATE public.agent_templates SET creator_id = $1 WHERE id = 5', [
              OTHER,
            ]);
          } catch (error) {
            rejected = pgErrorCode(error) === '42501';
          }
          expect(rejected).toBe(true);
          await client.query('ROLLBACK TO SAVEPOINT denied_update');

          // Only own rows delete; the foreign creator's rows do not.
          const deleted = await client.query<{ id: number }>(
            'DELETE FROM public.agent_templates WHERE id IN (2, 5) RETURNING id',
          );
          expect(deleted.rows).toEqual([{ id: 5 }]);
        } finally {
          await client.query('ROLLBACK');
        }
      });
    });

    test('an anonymous JWT sees public rows only', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query('BEGIN');
        await client.query(`SET LOCAL request.jwt.claims = '{}'`);
        await client.query('SET LOCAL ROLE authenticated');
        const visible = await client.query<{ id: number }>(
          'SELECT id FROM public.agent_templates ORDER BY id',
        );
        // The row-access test rolled its transaction back, so the table holds
        // only the fixture rows and row 1 is private again.
        expect(visible.rows).toEqual([{ id: 3 }]);
        const deleted = await client.query<{ id: number }>(
          'DELETE FROM public.agent_templates RETURNING id',
        );
        expect(deleted.rows).toEqual([]);
        await client.query('ROLLBACK');
      });
    });

    test('a dropped policy and a dropped table are both guarded no-ops', async () => {
      await withClient(superuserUrl, async (admin) => {
        await admin.query(
          'DROP POLICY "Users can delete their own templates" ON public.agent_templates',
        );
        await admin.query(migrationSql);
        const dropped = await admin.query(
          `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_templates'
           AND policyname = 'Users can delete their own templates'`,
        );
        expect(dropped.rowCount).toBe(0);

        await admin.query('DROP TABLE public.agent_templates');
        await admin.query(migrationSql);
        const gone = await admin.query(
          "SELECT to_regclass('public.agent_templates') IS NOT NULL AS present",
        );
        expect(gone.rows[0].present).toBe(false);
      });
    });
  });
});
