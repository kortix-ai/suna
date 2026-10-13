import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Regression test for the Supabase performance advisor lint
 * `multiple_permissive_policies` on `public.user_roles` (KRTX-1166).
 *
 * `public.user_roles` is a legacy table from the pre-monorepo database. It is
 * created by neither the baseline nor any later migration, so on a fresh
 * database the fix migration is a guarded no-op. On the long-lived databases
 * the table carries two PERMISSIVE policies that both target PUBLIC:
 * "Service role can manage all roles" (ALL, `auth.role() = 'service_role'`) and
 * "Users can view their own role" (SELECT, `auth.uid() = user_id`). The
 * advisor's rule (supabase/splinter 0006_multiple_permissive_policies) expands
 * every permissive policy to the roles it applies to — a PUBLIC policy applies
 * to every non-BYPASSRLS role — and flags any (role, action) group with more
 * than one policy, so both policies fire on every such role for SELECT.
 *
 * This suite rebuilds the legacy state on the lane's migrated database and
 * asserts, in order:
 *   1. the fix migration is a no-op on the fresh-install shape (no legacy
 *      table, no policies),
 *   2. the advisor's own rule flags the legacy state — the finding reproduced,
 *   3. the access matrix holds before the migration: an authenticated member
 *      sees only their own row and cannot write (the user policy is
 *      SELECT-only), and a role outside the request path sees nothing,
 *   4. after the committed migration file applies, the rule no longer flags
 *      the table, each policy carries its intended role scope, and both
 *      predicates are byte-identical (ALTER POLICY rewrites only the role
 *      list),
 *   5. the access matrix is unchanged after the migration.
 *
 * Fixture DDL runs through TEST_DATABASE_SUPERUSER_URL so the suite does not
 * depend on lane-role privileges; the table then moves to the lane role, so
 * the migration and the RLS checks run as the role prod's migration runner
 * runs as.
 */

const laneUrl = process.env.TEST_DATABASE_URL;
const superuserUrl = process.env.TEST_DATABASE_SUPERUSER_URL;

if (!laneUrl) throw new Error('TEST_DATABASE_URL is not set');
if (!superuserUrl) throw new Error('TEST_DATABASE_SUPERUSER_URL is not set');

const MIGRATION_GLOB = '*_user_roles_policy_role_scope.sql';

/** The advisor's rule (supabase/splinter 0006_multiple_permissive_policies), scoped to the table under test. */
const ADVISOR_FLAGS_MULTIPLE_PERMISSIVE = `
  SELECT r.rolname, act.cmd, array_agg(p.polname ORDER BY p.polname) AS policies
  FROM pg_catalog.pg_policy p
  JOIN pg_catalog.pg_class c ON p.polrelid = c.oid
  JOIN pg_catalog.pg_namespace n ON c.relnamespace = n.oid
  JOIN pg_catalog.pg_roles r
    ON p.polroles @> array[r.oid]
    OR p.polroles = array[0::oid]
  CROSS JOIN LATERAL (
    SELECT x.cmd
    FROM unnest(
      CASE p.polcmd
        WHEN 'r' THEN array['SELECT']::text[]
        WHEN 'a' THEN array['INSERT']::text[]
        WHEN 'w' THEN array['UPDATE']::text[]
        WHEN 'd' THEN array['DELETE']::text[]
        WHEN '*' THEN array['SELECT', 'INSERT', 'UPDATE', 'DELETE']::text[]
        ELSE array['ERROR']::text[]
      END
    ) x(cmd)
  ) act
  WHERE c.relkind = 'r'
    AND p.polpermissive
    AND n.nspname = 'public'
    AND c.relname = 'user_roles'
    AND r.rolname NOT LIKE 'pg_%'
    AND r.rolname NOT LIKE 'supabase%admin'
    AND NOT r.rolbypassrls
  GROUP BY r.rolname, act.cmd
  HAVING count(*) > 1
`;

/** The legacy table as prod carries it (information_schema.columns, read-only; FKs omitted — they are not RLS state). */
const LEGACY_TABLE_SQL = `
  CREATE TABLE public.user_roles (
    user_id uuid PRIMARY KEY,
    role text NOT NULL DEFAULT 'user',
    granted_by uuid,
    granted_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb
  )
`;

/** The legacy policies exactly as the long-lived databases carry them after 20261004120001000 (pg_policies, read-only). */
const LEGACY_SERVICE_POLICY_SQL = `
  CREATE POLICY "Service role can manage all roles" ON public.user_roles
    USING ((select auth.role()) = 'service_role'::text)
`;
const LEGACY_USERS_POLICY_SQL = `
  CREATE POLICY "Users can view their own role" ON public.user_roles
    FOR SELECT USING ((select auth.uid()) = user_id)
`;

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROBE_ROLE = 'user_roles_scope_probe';

/** What each subject role can observe on the table. Captured before and after the migration. */
interface AccessMatrix {
  authenticatedVisibleUserIds: string[];
  authenticatedInsertOwnCode: string | null;
  authenticatedInsertForeignCode: string | null;
  unauthenticatedVisibleRows: number;
}

let migrationSql: string;
let laneRole: string;
let beforeMatrix: AccessMatrix;
let beforePolicyShape: { qual: string; with_check: string | null }[];

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

/** The pg_policies row of one policy, ordered by name for stable capture. */
async function policyShape(client: pg.Client) {
  const rows = await client.query<{
    policyname: string;
    roles: string;
    cmd: string;
    permissive: string;
    qual: string;
    with_check: string | null;
  }>(
    `SELECT policyname, roles::text AS roles, cmd, permissive, qual, with_check
     FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'user_roles'
     ORDER BY policyname`,
  );
  return rows;
}

/** Reads what each subject role sees and may write, under the same settings each time. */
async function captureMatrix(client: pg.Client): Promise<AccessMatrix> {
  await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO authenticated');
  await client.query('ALTER TABLE public.user_roles FORCE ROW LEVEL SECURITY');
  try {
    await client.query('BEGIN');
    // The user policy is auth.uid() = user_id, so the JWT sub must be the
    // user id of the rows the member may see.
    await client.query(`SET LOCAL request.jwt.claim.sub = '${USER_A}'`);
    // postgres has BYPASSRLS on some Supabase images; FORCE RLS does not stop it.
    await client.query('SET LOCAL ROLE authenticated');
    const visible = await client.query<{ user_id: string }>(
      'SELECT user_id::text AS user_id FROM public.user_roles ORDER BY 1',
    );
    let insertOwnCode: string | null = null;
    try {
      await client.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'user')`, [
        USER_A,
      ]);
    } catch (error) {
      insertOwnCode = pgErrorCode(error) ?? null;
    }
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    await client.query(`SET LOCAL request.jwt.claim.sub = '${USER_A}'`);
    await client.query('SET LOCAL ROLE authenticated');
    let insertForeignCode: string | null = null;
    try {
      await client.query(`INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'user')`, [
        USER_B,
      ]);
    } catch (error) {
      insertForeignCode = pgErrorCode(error) ?? null;
    }
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    const unauthenticated = await client.query<{ count: string }>(
      'SELECT count(*) AS count FROM public.user_roles',
    );
    await client.query('ROLLBACK');

    return {
      authenticatedVisibleUserIds: visible.rows.map((row) => row.user_id),
      authenticatedInsertOwnCode: insertOwnCode,
      authenticatedInsertForeignCode: insertForeignCode,
      unauthenticatedVisibleRows: Number(unauthenticated.rows[0].count),
    };
  } finally {
    await client.query('ALTER TABLE public.user_roles NO FORCE ROW LEVEL SECURITY');
  }
}

describe('user_roles policy role scope migration', () => {
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
      await admin.query('DROP TABLE IF EXISTS public.user_roles CASCADE');
      await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
    });
  });

  test('fresh-install shape: the migration is a no-op (no legacy table, no policies)', async () => {
    await withClient(laneUrl, async (client) => {
      // The lane database is a fresh install shape: the legacy table must not
      // pre-exist, or this suite would be testing a state prod is not in.
      const preexisting = await client.query(
        `SELECT to_regclass('public.user_roles') IS NOT NULL AS present`,
      );
      expect(preexisting.rows[0].present).toBe(false);

      await client.query(migrationSql);
      const created = await client.query(
        `SELECT to_regclass('public.user_roles') IS NOT NULL AS present`,
      );
      expect(created.rows[0].present).toBe(false);
      const policies = await client.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_roles'`,
      );
      expect(policies.rowCount).toBe(0);
    });
  });

  describe('with the legacy state present', () => {
    beforeAll(async () => {
      // The fixture DDL runs as the superuser and hands the table to the lane
      // role, which is the role prod's migration runner runs as.
      await withClient(superuserUrl, async (admin) => {
        // A NOBYPASSRLS role outside the PostgREST request path (not
        // authenticated, not service_role): RLS applies to it, unlike the
        // service-role path, which every Supabase env exempts with BYPASSRLS.
        await admin.query(`DROP ROLE IF EXISTS ${PROBE_ROLE}`);
        await admin.query(`CREATE ROLE ${PROBE_ROLE} NOLOGIN NOBYPASSRLS`);
        await admin.query(`GRANT ${PROBE_ROLE} TO ${laneRole}`);
        await admin.query(`GRANT USAGE ON SCHEMA auth TO ${laneRole}`);
        await admin.query(LEGACY_TABLE_SQL);
        await admin.query('ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY');
        await admin.query(LEGACY_SERVICE_POLICY_SQL);
        await admin.query(LEGACY_USERS_POLICY_SQL);
        // Superuser inserts bypass RLS; prod's rows were written by its API role.
        await admin.query(
          `INSERT INTO public.user_roles (user_id, role) VALUES ($1, 'user'), ($2, 'admin')`,
          [USER_A, USER_B],
        );
        await admin.query(`ALTER TABLE public.user_roles OWNER TO ${laneRole}`);
        await admin.query(`GRANT SELECT ON public.user_roles TO ${PROBE_ROLE}`);
      });
    });

    test('the advisor rule flags the legacy policies (the finding reproduced)', async () => {
      await withClient(laneUrl, async (client) => {
        const flagged = await client.query(ADVISOR_FLAGS_MULTIPLE_PERMISSIVE);
        expect(flagged.rowCount).toBeGreaterThanOrEqual(1);
        // Every flagged group is the SELECT pair of the two PUBLIC policies.
        for (const row of flagged.rows) {
          expect(row.cmd).toBe('SELECT');
          expect(row.policies).toBe(
            '{"Service role can manage all roles","Users can view their own role"}',
          );
        }
      });
    });

    test('the access matrix holds before the migration', async () => {
      await withClient(laneUrl, async (client) => {
        beforeMatrix = await captureMatrix(client);
        expect(beforeMatrix.authenticatedVisibleUserIds).toEqual([USER_A]);
        expect(beforeMatrix.authenticatedInsertOwnCode).toBe('42501');
        expect(beforeMatrix.authenticatedInsertForeignCode).toBe('42501');
        expect(beforeMatrix.unauthenticatedVisibleRows).toBe(0);

        const shape = await policyShape(client);
        expect(shape.rowCount).toBe(2);
        beforePolicyShape = shape.rows.map((row) => ({
          qual: row.qual,
          with_check: row.with_check,
        }));
      });
    });

    test('the migration scopes both policies and leaves every predicate byte-identical', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query(migrationSql);

        const flagged = await client.query(ADVISOR_FLAGS_MULTIPLE_PERMISSIVE);
        expect(flagged.rowCount).toBe(0);

        const rows = await policyShape(client);
        expect(rows.rowCount).toBe(2);
        const service = rows.rows.find(
          (row) => row.policyname === 'Service role can manage all roles',
        );
        const users = rows.rows.find((row) => row.policyname === 'Users can view their own role');
        expect(service).toMatchObject({
          roles: '{service_role}',
          cmd: 'ALL',
          permissive: 'PERMISSIVE',
          with_check: null,
        });
        expect(users).toMatchObject({
          roles: '{authenticated}',
          cmd: 'SELECT',
          permissive: 'PERMISSIVE',
          with_check: null,
        });
        // ALTER POLICY rewrites only the role list: every predicate survives
        // byte-identical, whatever shape the environment's predicates carry.
        expect(rows.rows.map((row) => ({ qual: row.qual, with_check: row.with_check }))).toEqual(
          beforePolicyShape,
        );
      });
    });

    test('row access is unchanged after the migration', async () => {
      await withClient(laneUrl, async (client) => {
        const afterMatrix = await captureMatrix(client);
        expect(afterMatrix).toEqual(beforeMatrix);

        // A NOBYPASSRLS role outside the request path sees nothing, before and
        // after: it never satisfied either predicate.
        await withClient(laneUrl, async (probeClient) => {
          await probeClient.query('BEGIN');
          await probeClient.query(`SET LOCAL ROLE ${PROBE_ROLE}`);
          const visible = await probeClient.query(
            'SELECT count(*) AS count FROM public.user_roles',
          );
          expect(Number(visible.rows[0].count)).toBe(0);
          await probeClient.query('ROLLBACK');
        });
      });
    });
  });
});
