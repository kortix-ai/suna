/**
 * The `credit_ledger` RLS initplan rewrite, against a real PostgreSQL.
 *
 * The migration rewrites the legacy policy "Service role manages ledger" on
 * the pre-baseline table `public.credit_ledger` (KRTX-1122) so its bare
 * `auth.role()` call is wrapped in `(select ...)`, which Postgres evaluates
 * once per statement as an init plan instead of once per row (Supabase
 * advisor lint `auth_rls_initplan`, KRTX-1138). Five things are worth a test:
 *   1. the migration is a guarded no-op on the fresh-install shape (the
 *      baseline builds only `kortix.credit_ledger`),
 *   2. the advisor's own rule flags the legacy policy and the read plan
 *      re-evaluates the call per row — the finding reproduced,
 *   3. after the migration applies, the rule no longer flags it, the plan
 *      carries the init plan, and the policy keeps its shape (cmd ALL, roles
 *      {public}, implicit WITH CHECK),
 *   4. row access is unchanged: a service-role claim reads and writes every
 *      row, any other claim reads nothing and may write nothing — before and
 *      after the rewrite,
 *   5. a policy with an unexpected predicate (the baseline's wrapped form, or
 *      any other shape) is left untouched — the guard never rewrites an
 *      access rule the advisor did not describe.
 *
 * The fixture table is the legacy table in prod's exact column shape (the
 * same fixture `tests/migration/legacy-credit-ledger-created-by-index.test.ts`
 * seeds, minus the FKs, which an RLS policy does not read). Fixture DDL and
 * role creation run through TEST_DATABASE_SUPERUSER_URL because the lane role
 * cannot create objects in the public schema; the table then moves to the lane
 * role, which is the role prod's migration runner runs as.
 *
 * The probes run as a dedicated NOBYPASSRLS role with a JWT claim GUC. The
 * lane's `postgres` and `service_role` roles carry BYPASSRLS, so either would
 * skip the policy entirely and prove nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const laneUrl = process.env.TEST_DATABASE_URL;
const superuserUrl = process.env.TEST_DATABASE_SUPERUSER_URL;

if (!laneUrl) throw new Error('TEST_DATABASE_URL is not set');
if (!superuserUrl) throw new Error('TEST_DATABASE_SUPERUSER_URL is not set');

const MIGRATION_GLOB = '*_wrap_credit_ledger_rls_auth_initplan.sql';
const TABLE = 'public.credit_ledger';
const POLICY = 'Service role manages ledger';
const PROBE_ROLE = 'credit_ledger_rls_probe';
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** The advisor's `auth_rls_initplan` rule for auth.role(), scoped to the table under test. */
const LINTER_FINDS_BARE_AUTH_ROLE = `
  SELECT policyname FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'credit_ledger'
    AND policyname = '${POLICY}'
    AND qual ~ '(auth\\.)?role\\(\\)'
    AND lower(qual) !~ 'select[[:space:]]+(auth\\.)?role\\(\\)'
`;

/** The legacy policy exactly as prod carries it (verified read-only, 2026-10-03:
 *  cmd ALL, roles {public}, with_check NULL, qual `auth.role() =
 *  'service_role'::text`). */
const LEGACY_POLICY_SQL = `
  CREATE POLICY "${POLICY}" ON ${TABLE}
    USING ((auth.role() = 'service_role'::text))
`;

/** The legacy table in prod's exact column order (the KRTX-1122 fixture). */
const LEGACY_TABLE_SQL = `
  CREATE TABLE ${TABLE} (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL,
    amount numeric(12,4) DEFAULT 0 NOT NULL,
    balance_after numeric(12,4) DEFAULT 0 NOT NULL,
    type text NOT NULL,
    description text,
    reference_id uuid,
    reference_type text,
    metadata jsonb DEFAULT '{}',
    created_at timestamptz DEFAULT now(),
    created_by uuid,
    is_expiring boolean DEFAULT true,
    expires_at timestamptz,
    stripe_event_id varchar(255),
    message_id uuid,
    thread_id uuid,
    processing_source text,
    idempotency_key text,
    locked_at timestamptz
  )
`;

let migrationSql: string;
let laneRole: string;

/** The PostgreSQL error code of a driver error, or undefined when the error carries none. */
function pgErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown };
  return typeof value.code === 'string' ? value.code : undefined;
}

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Rows the probe role sees for one JWT claim, read inside a rolled-back
 *  transaction because SET LOCAL is transaction-scoped. No claim means the
 *  request carried no role at all. */
async function probeRowCount(claim?: string): Promise<string> {
  return withClient(laneUrl, async (client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${PROBE_ROLE}`);
    if (claim) await client.query(`SET LOCAL request.jwt.claim.role = '${claim}'`);
    const count = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${TABLE}`);
    await client.query('ROLLBACK');
    return count.rows[0].count;
  });
}

/** The plan the probe role gets for a plain read with RLS active. */
async function probePlan(claim?: string): Promise<string> {
  return withClient(laneUrl, async (client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${PROBE_ROLE}`);
    if (claim) await client.query(`SET LOCAL request.jwt.claim.role = '${claim}'`);
    const plan = await client.query(`EXPLAIN (COSTS OFF) SELECT account_id FROM ${TABLE}`);
    await client.query('ROLLBACK');
    return plan.rows.map((row) => Object.values(row)[0]).join('\n');
  });
}

/** One INSERT attempt by the probe role for one JWT claim, rolled back either
 *  way so the fixture rows stay the only rows. Resolves to 'ok' or the SQLSTATE. */
async function probeInsert(claim?: string): Promise<string> {
  return withClient(laneUrl, async (client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${PROBE_ROLE}`);
    if (claim) await client.query(`SET LOCAL request.jwt.claim.role = '${claim}'`);
    let result: string;
    try {
      await client.query(
        `INSERT INTO ${TABLE} (account_id, type) VALUES ('${ACCOUNT_A}', 'usage')`,
      );
      result = 'ok';
    } catch (error) {
      result = pgErrorCode(error) ?? 'error';
    }
    await client.query('ROLLBACK');
    return result;
  });
}

/** The allowed and denied paths of the policy, the same assertions before and
 *  after the rewrite: a service-role claim reads and writes every row, any
 *  other claim (and no claim) reads and writes nothing. */
async function expectUnchangedRowAccess(): Promise<void> {
  expect(await probeRowCount('service_role')).toBe('2');
  expect(await probeInsert('service_role')).toBe('ok');
  expect(await probeRowCount('authenticated')).toBe('0');
  expect(await probeInsert('authenticated')).toBe('42501');
  expect(await probeRowCount()).toBe('0');
  expect(await probeInsert()).toBe('42501');
}

async function dropLegacyFixture(admin: pg.Client): Promise<void> {
  await admin.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
}

/** The legacy state prod carries and the advisor flags. */
async function createLegacyFixture(admin: pg.Client, laneRoleName: string): Promise<void> {
  await dropLegacyFixture(admin);
  await admin.query(LEGACY_TABLE_SQL);
  await admin.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
  await admin.query(LEGACY_POLICY_SQL);
  await admin.query(
    `INSERT INTO ${TABLE} (account_id, type) VALUES ('${ACCOUNT_A}', 'usage'), ('${ACCOUNT_B}', 'usage')`,
  );
  await admin.query(`GRANT SELECT, INSERT ON ${TABLE} TO ${PROBE_ROLE}`);
  await admin.query(`ALTER TABLE ${TABLE} OWNER TO ${laneRoleName}`);
}

async function readPolicy(): Promise<Record<string, unknown> | undefined> {
  return withClient(laneUrl, async (client) => {
    const row = await client.query(
      `SELECT policyname, cmd, permissive, roles::text AS roles, qual::text, with_check::text
       FROM pg_policies WHERE schemaname = 'public' AND tablename = 'credit_ledger'`,
    );
    return row.rows[0];
  });
}

describe('credit_ledger RLS auth_rls_initplan migration', () => {
  beforeAll(async () => {
    // This suite drops and recreates a table named like a real prod table in
    // the public schema. The db-suites lane provides an ephemeral per-file
    // database (kortix_dbsuite_<pid>_<n>); refuse to run against anything
    // else — for example a long-lived development database handed over by a
    // stray direct `bun test` — rather than destroying its data.
    const database = new URL(laneUrl).pathname.replace(/^\//, '');
    if (!database.startsWith('kortix_dbsuite_')) {
      throw new Error(
        `TEST_DATABASE_URL must point at an ephemeral kortix_dbsuite_* lane database; got '${database}'. Run through \`pnpm test -- --db-only <file>\` (tests/bin/db-suites.ts).`,
      );
    }

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

    // The probe role: NOLOGIN, and above all NOBYPASSRLS, so RLS governs it.
    await withClient(superuserUrl, async (admin) => {
      const exists = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}'`);
      if (exists.rowCount === 0) {
        await admin.query(`CREATE ROLE ${PROBE_ROLE} NOLOGIN NOBYPASSRLS`);
      }
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
      await admin.query(`GRANT ${PROBE_ROLE} TO ${laneRole}`);
    });
  });

  afterAll(async () => {
    await withClient(superuserUrl, async (admin) => {
      await dropLegacyFixture(admin);
      // DROP ROLE refuses a role that still holds privileges or memberships.
      const probe = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = '${PROBE_ROLE}'`);
      if (probe.rowCount) {
        await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${PROBE_ROLE}`);
        await admin.query(`REVOKE ${PROBE_ROLE} FROM ${laneRole}`);
        await admin.query(`DROP ROLE ${PROBE_ROLE}`);
      }
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

      await client.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);
      const created = await client.query(`SELECT to_regclass('${TABLE}') IS NOT NULL AS present`);
      expect(created.rows[0].present).toBe(false);
    });
  });

  describe('with the legacy state present', () => {
    beforeAll(async () => {
      await withClient(superuserUrl, async (admin) => {
        await createLegacyFixture(admin, laneRole);
      });
    });

    test('the legacy policy re-evaluates auth.role() per row (the advisor finding)', async () => {
      await withClient(laneUrl, async (client) => {
        const flagged = await client.query(LINTER_FINDS_BARE_AUTH_ROLE);
        expect(flagged.rowCount).toBe(1);
      });
      expect(await probePlan('service_role')).not.toContain('InitPlan');
    });

    test('row access before the rewrite: service-role writes, every other claim is denied', async () => {
      await expectUnchangedRowAccess();
    });

    test('the migration wraps the call and preserves the policy shape', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);

        const flagged = await client.query(LINTER_FINDS_BARE_AUTH_ROLE);
        expect(flagged.rowCount).toBe(0);
      });

      const policy = await readPolicy();
      expect(policy?.policyname).toBe(POLICY);
      expect(policy?.cmd).toBe('ALL');
      expect(policy?.permissive).toBe('PERMISSIVE');
      expect(policy?.roles).toBe('{public}');
      expect(String(policy?.qual)).toMatch(/select\s+(auth\.)?role\(\)/i);
      // Prod declares no WITH CHECK on this policy; the rewrite keeps it that way.
      expect(policy?.with_check).toBeNull();

      const rls = await withClient(laneUrl, async (client) => {
        const row = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
          `SELECT relrowsecurity, relforcerowsecurity FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'credit_ledger'`,
        );
        return row.rows[0];
      });
      expect(rls.relrowsecurity).toBe(true);
      expect(rls.relforcerowsecurity).toBe(false);
    });

    test('the read plan evaluates the call once per statement, not per row', async () => {
      expect(await probePlan('service_role')).toContain('InitPlan');
    });

    test('row access after the rewrite: unchanged', async () => {
      await expectUnchangedRowAccess();
    });

    test('a second apply is idempotent: one policy, still the initplan form', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);
      });
      const policy = await readPolicy();
      expect(String(policy?.qual)).toMatch(/select\s+(auth\.)?role\(\)/i);
      expect(await probePlan('service_role')).toContain('InitPlan');
    });
  });

  test('the guard leaves an unexpected predicate untouched (the baseline wrapped form)', async () => {
    await withClient(superuserUrl, async (admin) => {
      await dropLegacyFixture(admin);
      await admin.query(LEGACY_TABLE_SQL);
      await admin.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
      await admin.query(
        `CREATE POLICY "${POLICY}" ON ${TABLE}
           USING ((( SELECT auth.role() AS role) = 'service_role'::text))`,
      );
      await admin.query(`GRANT SELECT, INSERT ON ${TABLE} TO ${PROBE_ROLE}`);
      await admin.query(`ALTER TABLE ${TABLE} OWNER TO ${laneRole}`);
    });

    await withClient(laneUrl, async (client) => {
      await client.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);
    });

    const policy = await readPolicy();
    expect(String(policy?.qual)).toContain('SELECT auth.role() AS role');
  });

  test('never invents a policy on a table whose RLS runs with none', async () => {
    await withClient(superuserUrl, async (admin) => {
      await dropLegacyFixture(admin);
      await admin.query(`CREATE TABLE ${TABLE} (account_id uuid NOT NULL)`);
      await admin.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
      await admin.query(`INSERT INTO ${TABLE} (account_id) VALUES ('${ACCOUNT_A}')`);
      await admin.query(`GRANT SELECT ON ${TABLE} TO ${PROBE_ROLE}`);
      await admin.query(`ALTER TABLE ${TABLE} OWNER TO ${laneRole}`);
    });

    await withClient(laneUrl, async (client) => {
      await client.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);
    });

    const policies = await withClient(laneUrl, async (client) => {
      const row = await client.query(
        `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'credit_ledger'`,
      );
      return row.rowCount ?? 0;
    });
    expect(policies).toBe(0);
    // The seeded row exists, and RLS with no policy denies it to every claim —
    // the migration did not invent one to hand access back.
    expect(await probeRowCount()).toBe('0');
    expect(await probeRowCount('service_role')).toBe('0');
  });
});
