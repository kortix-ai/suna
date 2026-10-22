import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Regression test for the Supabase performance advisor lint
 * `auth_rls_initplan` on `public.user_memories` (KRTX-1149).
 *
 * `public.user_memories` is a legacy table from the pre-monorepo database. It
 * is created by neither the baseline nor 0000_bootstrap, so on a fresh
 * database the fix migration is a guarded no-op. On the long-lived databases
 * the table carries four `authenticated` policies ("Users can view / insert /
 * update / delete their own memories") whose shared membership predicate calls
 * `auth.uid()` bare — Postgres may re-evaluate it for every row instead of
 * planning it once per statement, which is what the advisor flags.
 *
 * This suite rebuilds the legacy state on the lane's migrated database and
 * asserts, in order:
 *   1. the fix migration is a guarded no-op on the fresh-install shape,
 *   2. the advisor's own rule (supabase/splinter 0003_auth_rls_initplan, the
 *      `auth.uid()` branch) flags all four legacy policies — the finding
 *      reproduced,
 *   3. after the committed migration file applies, the rule no longer flags
 *      any of them and every policy keeps its shape (name, roles, command,
 *      permissiveness, RLS enabled, and the service_role policy untouched),
 *   4. row access is unchanged through both predicate branches: the account's
 *      primary owner and a plain member see and write only their own
 *      account's memories, a request without a JWT claim sees none. The lane
 *      role owns the table (as prod's API role does), so FORCE RLS puts it
 *      under the policies.
 *
 * Fixture DDL runs through TEST_DATABASE_SUPERUSER_URL because the lane role
 * cannot create objects in the public schema; the suite then reassigns the
 * table to the lane role so the migration and the RLS checks run as the role
 * prod's migration runner runs as. The fixture omits the `embedding` (pgvector)
 * and `memory_type` (enum) columns: platform artifacts irrelevant to RLS.
 */

const laneUrl = process.env.TEST_DATABASE_URL;
const superuserUrl = process.env.TEST_DATABASE_SUPERUSER_URL;

if (!laneUrl) throw new Error('TEST_DATABASE_URL is not set');
if (!superuserUrl) throw new Error('TEST_DATABASE_SUPERUSER_URL is not set');

const MIGRATION_GLOB = '*_user_memories_rls_auth_initplan.sql';

const TABLE = 'public.user_memories';
const SERVICE_POLICY = 'Service role has full access to memories';
/** The four authenticated policies, with the command and check shape prod carries. */
const USER_POLICIES: Array<{ name: string; cmd: string; withCheck: boolean }> = [
  { name: 'Users can view their own memories', cmd: 'SELECT', withCheck: false },
  { name: 'Users can insert their own memories', cmd: 'INSERT', withCheck: true },
  { name: 'Users can update their own memories', cmd: 'UPDATE', withCheck: false },
  { name: 'Users can delete their own memories', cmd: 'DELETE', withCheck: false },
];

/** The advisor's `auth_rls_initplan` rule for auth.uid(), scoped to the table under
 *  test. The rule reads BOTH expressions: a policy carries its filter in `qual`
 *  (SELECT/UPDATE/DELETE) or in `with_check` (INSERT). */
const LINTER_FINDS_BARE_AUTH_UID = `
  SELECT policyname FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'user_memories'
    AND (
      (qual LIKE '%auth.uid()%' AND lower(qual) NOT LIKE '%select auth.uid()%')
      OR (with_check LIKE '%auth.uid()%' AND lower(with_check) NOT LIKE '%select auth.uid()%')
    )
`;

/** The legacy policy exactly as prod carries it (pg_policies.qual, re-written as SQL):
 *  account membership through basejump, via the primary owner OR a plain member. */
const MEMBERSHIP_PREDICATE = `
  account_id IN (
    SELECT accounts.id
    FROM basejump.accounts
    WHERE accounts.primary_owner_user_id = auth.uid()
       OR accounts.id IN (
         SELECT account_user.account_id
         FROM basejump.account_user
         WHERE account_user.user_id = auth.uid()
       )
  )
`;

const LEGACY_TABLE_SQL = `
  CREATE TABLE public.user_memories (
    memory_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL,
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )
`;

const LEGACY_SERVICE_POLICY_SQL = `
  CREATE POLICY "${SERVICE_POLICY}" ON public.user_memories
    TO service_role USING (true) WITH CHECK (true)
`;

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let migrationSql: string;
let laneRole: string;
let createdBasejumpAccounts = false;

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

/** The plan an authenticated client gets for a plain read, with RLS active:
 *  whether the auth call is a one-per-statement InitPlan or an inline filter. */
async function probePlan(client: pg.Client, subject: string): Promise<string> {
  await client.query('BEGIN');
  await client.query(`SET LOCAL request.jwt.claim.sub = '${subject}'`);
  // postgres has BYPASSRLS on some Supabase images; SET ROLE drops it.
  await client.query('SET LOCAL ROLE authenticated');
  const plan = await client.query('EXPLAIN (COSTS OFF) SELECT content FROM public.user_memories');
  await client.query('ROLLBACK');
  return plan.rows.map((row) => Object.values(row)[0]).join('\n');
}

/** The membership predicate the four legacy policies share, with bare auth.uid(). */
function legacyPolicySql(name: string, cmd: string, withCheck: boolean): string {
  const clause = withCheck
    ? `WITH CHECK (${MEMBERSHIP_PREDICATE})`
    : `USING (${MEMBERSHIP_PREDICATE})`;
  return `CREATE POLICY "${name}" ON public.user_memories FOR ${cmd} TO authenticated ${clause}`;
}

/** Flags the policies the advisor's rule names for bare auth.uid(). */
async function flaggedPolicies(client: pg.Client): Promise<string[]> {
  const flagged = await client.query(LINTER_FINDS_BARE_AUTH_UID);
  return flagged.rows.map((row) => row.policyname as string).sort();
}

describe('user_memories RLS auth_rls_initplan migration', () => {
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
      await admin.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      // basejump.accounts exists on prod-shaped databases but not on the
      // lane's stub (and not at all when the fixture never ran): guard both
      // the drop and the row cleanup on its actual presence.
      const accounts = await admin.query(
        `SELECT to_regclass('basejump.accounts') IS NOT NULL AS present`,
      );
      if (!accounts.rows[0].present) return;
      if (createdBasejumpAccounts) {
        await admin.query('DROP TABLE IF EXISTS basejump.accounts CASCADE');
      } else {
        await admin.query('DELETE FROM basejump.accounts WHERE id IN ($1, $2)', [
          ACCOUNT_A,
          ACCOUNT_B,
        ]);
      }
      await admin.query('DELETE FROM basejump.account_user WHERE user_id IN ($1, $2, $3)', [
        USER_A,
        USER_B,
        USER_C,
      ]);
    });
  });

  test('fresh-install shape: the migration is a guarded no-op (no legacy table)', async () => {
    await withClient(laneUrl, async (client) => {
      // The lane database is a fresh install shape: the legacy table must not
      // pre-exist, or this suite would be testing a state prod is not in.
      const preexisting = await client.query(
        `SELECT to_regclass('${TABLE}') IS NOT NULL AS present`,
      );
      expect(preexisting.rows[0].present).toBe(false);

      await client.query(migrationSql);
      const created = await client.query(`SELECT to_regclass('${TABLE}') IS NOT NULL AS present`);
      expect(created.rows[0].present).toBe(false);
      const policies = await client.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_memories'`,
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
        if (
          (await admin.query(`SELECT to_regclass('basejump.accounts') IS NOT NULL AS present`))
            .rows[0].present
        ) {
          createdBasejumpAccounts = false;
        } else {
          createdBasejumpAccounts = true;
          await admin.query(
            `CREATE TABLE basejump.accounts (
               id uuid PRIMARY KEY,
               primary_owner_user_id uuid NOT NULL,
               personal_account boolean NOT NULL DEFAULT true,
               created_at timestamptz DEFAULT now()
             )`,
          );
        }
        // USER_A owns account A (the primary-owner branch); USER_B owns
        // account B and USER_C is its plain member (the membership branch).
        await admin.query(
          `INSERT INTO basejump.accounts (id, primary_owner_user_id) VALUES ($1, $3), ($2, $4)
           ON CONFLICT (id) DO NOTHING`,
          [ACCOUNT_A, ACCOUNT_B, USER_A, USER_B],
        );
        await admin.query(
          `INSERT INTO basejump.account_user (user_id, account_id, account_role)
           VALUES ($1, $3, 'owner'), ($2, $4, 'owner'), ($5, $4, 'member')
           ON CONFLICT (user_id, account_id) DO NOTHING`,
          [USER_A, USER_B, ACCOUNT_A, ACCOUNT_B, USER_C],
        );
        // The legacy policies' subqueries read basejump as the querying role,
        // exactly as they do for an authenticated client. Prod grants USAGE on
        // basejump and auth to postgres and authenticated; the lane's
        // superuser-created stubs (and the --no-privileges auth dump) carry no
        // such grant, so mirror prod here for both schemas.
        await admin.query('GRANT USAGE ON SCHEMA basejump TO PUBLIC');
        await admin.query('GRANT SELECT ON basejump.accounts TO PUBLIC');
        await admin.query('GRANT SELECT ON basejump.account_user TO PUBLIC');
        await admin.query(`GRANT USAGE ON SCHEMA auth TO ${laneRole}`);

        await admin.query(LEGACY_TABLE_SQL);
        await admin.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
        await admin.query(LEGACY_SERVICE_POLICY_SQL);
        for (const { name, cmd, withCheck } of USER_POLICIES) {
          await admin.query(legacyPolicySql(name, cmd, withCheck));
        }
        await admin.query(`GRANT SELECT ON ${TABLE} TO authenticated`);
        // Superuser inserts bypass RLS; prod's rows were written by its API role.
        await admin.query(
          `INSERT INTO ${TABLE} (account_id, content)
           VALUES ($1, 'account A memory'), ($2, 'account B memory')`,
          [ACCOUNT_A, ACCOUNT_B],
        );
        await admin.query(`ALTER TABLE ${TABLE} OWNER TO ${laneRole}`);
      });
    });

    test('every legacy policy re-evaluates auth.uid() per row (the advisor finding)', async () => {
      await withClient(laneUrl, async (client) => {
        expect(await flaggedPolicies(client)).toEqual([...USER_POLICIES.map((p) => p.name)].sort());
        // The plan evaluates the auth call inline in the scan filters, not as
        // a one-per-statement init plan.
        const plan = await probePlan(client, USER_A);
        expect(plan).not.toContain('InitPlan');
      });
    });

    test('the migration replaces all four with the initplan form and preserves each policy shape', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query(migrationSql);

        expect(await flaggedPolicies(client)).toEqual([]);

        const plan = await probePlan(client, USER_A);
        expect(plan).toContain('InitPlan');

        for (const { name, cmd, withCheck } of USER_POLICIES) {
          const row = await client.query<{
            cmd: string;
            roles: string;
            permissive: string;
            qual: string;
            with_check: string | null;
          }>(
            `SELECT cmd, roles::text AS roles, permissive, qual::text AS qual, with_check::text AS with_check
             FROM pg_policies
             WHERE schemaname = 'public' AND tablename = 'user_memories' AND policyname = $1`,
            [name],
          );
          expect(row.rowCount).toBe(1);
          expect(row.rows[0].cmd).toBe(cmd);
          expect(row.rows[0].roles).toBe('{authenticated}');
          expect(row.rows[0].permissive).toBe('PERMISSIVE');
          if (withCheck) {
            // INSERT: the filter lives in WITH CHECK; qual stays null.
            expect(row.rows[0].qual).toBeNull();
            expect(row.rows[0].with_check).toContain('( SELECT auth.uid()');
          } else {
            expect(row.rows[0].qual).toContain('( SELECT auth.uid()');
            expect(row.rows[0].with_check).toBeNull();
          }
        }

        // The service_role policy is constant true and must survive untouched.
        const service = await client.query<{
          qual: string;
          with_check: string | null;
          roles: string;
        }>(
          `SELECT qual::text AS qual, with_check::text AS with_check, roles::text AS roles
           FROM pg_policies
           WHERE schemaname = 'public' AND tablename = 'user_memories' AND policyname = $1`,
          [SERVICE_POLICY],
        );
        expect(service.rowCount).toBe(1);
        expect(service.rows[0].qual).toBe('true');
        expect(service.rows[0].with_check).toBe('true');
        expect(service.rows[0].roles).toBe('{service_role}');

        const rls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'user_memories'`,
        );
        expect(rls.rows[0].relrowsecurity).toBe(true);
        expect(rls.rows[0].relforcerowsecurity).toBe(false);
      });
    });

    test('row access is unchanged: owner and member act only on their own account', async () => {
      await withClient(laneUrl, async (client) => {
        // The lane role owns the table, so FORCE RLS makes the policies apply
        // to it too — the same rows an authenticated client would see. Each
        // asUser block is one committed transaction, like a real client call.
        await client.query('GRANT ALL ON public.user_memories TO authenticated');
        await client.query('ALTER TABLE public.user_memories FORCE ROW LEVEL SECURITY');
        try {
          const asUser = async (user: string, fn: () => Promise<void>) => {
            await client.query('BEGIN');
            await client.query(`SET LOCAL request.jwt.claim.sub = '${user}'`);
            // postgres has BYPASSRLS on some Supabase images; FORCE RLS does not stop it.
            await client.query('SET LOCAL ROLE authenticated');
            try {
              await fn();
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            }
          };

          // SELECT: USER_A (primary owner of A) sees only account A's memory;
          // USER_C (member of B) sees only account B's; no claim sees none.
          await asUser(USER_A, async () => {
            const visible = await client.query<{ content: string }>(
              'SELECT content FROM public.user_memories',
            );
            expect(visible.rowCount).toBe(1);
            expect(visible.rows[0].content).toBe('account A memory');
          });
          await asUser(USER_C, async () => {
            const visible = await client.query<{ content: string }>(
              'SELECT content FROM public.user_memories',
            );
            expect(visible.rowCount).toBe(1);
            expect(visible.rows[0].content).toBe('account B memory');
          });
          await asUser('ffffffff-ffff-4fff-8fff-ffffffffffff', async () => {
            const visible = await client.query<{ content: string }>(
              'SELECT content FROM public.user_memories',
            );
            expect(visible.rowCount).toBe(0);
          });

          // INSERT: into the own account succeeds; into the other account the
          // WITH CHECK rejects (42501) and the transaction aborts.
          await asUser(USER_A, async () => {
            const inserted = await client.query<{ content: string }>(
              `INSERT INTO public.user_memories (account_id, content)
               VALUES ($1, 'own insert') RETURNING content`,
              [ACCOUNT_A],
            );
            expect(inserted.rows[0].content).toBe('own insert');
          });
          await asUser(USER_A, async () => {
            let rejected = false;
            try {
              await client.query(
                `INSERT INTO public.user_memories (account_id, content)
                 VALUES ($1, 'foreign insert')`,
                [ACCOUNT_B],
              );
            } catch (error) {
              rejected = pgErrorCode(error) === '42501';
            }
            expect(rejected).toBe(true);
          });

          // UPDATE and DELETE have USING only (no WITH CHECK, as prod does):
          // another account's row is invisible, so the statement matches zero
          // rows instead of erroring.
          await asUser(USER_B, async () => {
            const updated = await client.query<{ content: string }>(
              `UPDATE public.user_memories SET content = 'updated by owner'
               WHERE content = 'account B memory' RETURNING content`,
            );
            expect(updated.rowCount).toBe(1);
          });
          await asUser(USER_B, async () => {
            const foreign = await client.query<{ content: string }>(
              `UPDATE public.user_memories SET content = 'hijacked'
               WHERE content = 'account A memory' RETURNING content`,
            );
            expect(foreign.rowCount).toBe(0);
          });

          await asUser(USER_A, async () => {
            const deleted = await client.query<{ content: string }>(
              `DELETE FROM public.user_memories WHERE content = 'own insert' RETURNING content`,
            );
            expect(deleted.rowCount).toBe(1);
          });
          await asUser(USER_A, async () => {
            const foreign = await client.query<{ content: string }>(
              `DELETE FROM public.user_memories WHERE content = 'updated by owner' RETURNING content`,
            );
            expect(foreign.rowCount).toBe(0);

            // Every statement above left exactly the two account-scoped rows:
            // this subject sees only its own surviving row.
            const intact = await client.query<{ content: string }>(
              'SELECT content FROM public.user_memories',
            );
            expect(intact.rows.map((row) => row.content)).toEqual(['account A memory']);
          });
        } finally {
          await client.query('ALTER TABLE public.user_memories NO FORCE ROW LEVEL SECURITY');
        }
      });
    });

    test('re-applying the migration stays idempotent and keeps every policy', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query(migrationSql);

        expect(await flaggedPolicies(client)).toEqual([]);
        const all = await client.query(
          `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_memories'`,
        );
        expect(all.rowCount).toBe(USER_POLICIES.length + 1);
      });
    });
  });
});
