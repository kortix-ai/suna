/**
 * The `credit_ledger` RLS initplan rewrite, against a real PostgreSQL.
 *
 * The migration rewrites both legacy policies on the pre-baseline table
 * `public.credit_ledger` (KRTX-1122) — "Service role manages ledger" calls
 * `auth.role()` bare and "Users can view own ledger" calls `auth.uid()` bare
 * — so each call is wrapped in `(select ...)`, which Postgres evaluates once
 * per statement as an init plan instead of once per row (Supabase advisor
 * lint `auth_rls_initplan`; the lint is per policy, so the fix must cover
 * both, as the sibling legacy tables did). Five things are worth a test:
 *   1. the migration is a guarded no-op on the fresh-install shape (the
 *      baseline builds only `kortix.credit_ledger`),
 *   2. the advisor's own rule flags both legacy policies and the read plans
 *      re-evaluate their calls per row — the finding reproduced,
 *   3. after the migration applies, the rule flags nothing on the table, both
 *      plans carry the init plan, and both policies keep their shape (cmd
 *      ALL/SELECT, roles as found, implicit WITH CHECK),
 *   4. row access is unchanged: a service-role claim reads and writes every
 *      row, an authenticated claim reads only its own account's rows and may
 *      write nothing, a claim with neither role nor sub reads and writes
 *      nothing — before and after the rewrite,
 *   5. a policy with an unexpected predicate (the baseline's wrapped form, or
 *      any other shape) is left untouched — the guard never rewrites an
 *      access rule the advisor did not describe.
 *
 * The fixture table is the legacy table in prod's exact column shape (the
 * same fixture `tests/migration/legacy-credit-ledger-created-by-index.test.ts`
 * seeds, minus the FKs, which an RLS policy does not read). The two policies
 * mirror prod as it stands since KRTX-1162 scoped their roles
 * (`20261003145424808_legacy_credit_ledger_policy_roles.sql`): the service
 * policy to `service_role`, the users policy to `authenticated`. Fixture DDL
 * and role creation run through TEST_DATABASE_SUPERUSER_URL because the lane
 * role cannot create objects in the public schema; the table then moves to
 * the lane role, which is the role prod's migration runner runs as.
 *
 * The probes follow the lane convention `legacy-credit-ledger-policy-roles
 * .integration.test.ts` established: `SET LOCAL ROLE authenticated` / `anon`
 * / `service_role` with JWT claim GUCs. `SET ROLE` adopts the target role's
 * attributes, so `authenticated` and `anon` (neither carries BYPASSRLS) give
 * a genuinely RLS-governed path, while `service_role` bypasses RLS by design
 * — the service-role assertions pin that Supabase contract, not the policy
 * text. The policies are gated `TO service_role` / `TO authenticated`, so a
 * third-party role like the lane's `postgres` sees no policy apply at all.
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
const SERVICE_POLICY = 'Service role manages ledger';
const USERS_POLICY = 'Users can view own ledger';
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** The advisor's `auth_rls_initplan` rule, table-scoped: any policy whose
 *  qual or with_check calls auth.role()/auth.uid() (either pg_get_expr
 *  printing) without a `select` wrapper. Deliberately not pinned to a policy
 *  name — the advisor reports per policy on the whole table, so green must
 *  see every bare policy the fixture seeds. */
const LINTER_FINDS_BARE_AUTH_CALLS = `
  SELECT policyname FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = 'credit_ledger'
    AND (
      (qual ~ '(auth\\.)?(role|uid)\\(\\)'
        AND lower(qual) !~ 'select[[:space:]]+(auth\\.)?(role|uid)\\(\\)')
      OR (with_check ~ '(auth\\.)?(role|uid)\\(\\)'
        AND lower(with_check) !~ 'select[[:space:]]+(auth\\.)?(role|uid)\\(\\)')
    )
`;

/** The two legacy policies exactly as prod carries them today (the KRTX-1162
 *  prod-mirroring fixture: service policy cmd ALL to `service_role`, users
 *  policy SELECT to `authenticated`, both predicates bare, with_check NULL). */
const LEGACY_POLICIES_SQL = `
  CREATE POLICY "${SERVICE_POLICY}" ON ${TABLE}
    TO service_role
    USING ((auth.role() = 'service_role'::text));
  CREATE POLICY "${USERS_POLICY}" ON ${TABLE}
    FOR SELECT TO authenticated
    USING (auth.uid() = account_id)
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

/** One probe session: the PostgREST-shaped caller Postgres acts as on a
 *  request (`authenticated`, `anon` or `service_role`) plus the JWT claims
 *  that caller carries — `role` becomes request.jwt.claim.role and `sub`
 *  request.jwt.claim.sub, the two claims auth.role() and auth.uid() read.
 *  Every probe sets a role: the lane client itself carries BYPASSRLS and
 *  would skip the policies entirely. */
type Caller = 'authenticated' | 'anon' | 'service_role';
type Probe = { role: Caller; sub?: string };

/** Rows one probe sees, read inside a rolled-back transaction because SET
 *  LOCAL is transaction-scoped. */
async function probeRowCount(probe: Probe): Promise<string> {
  return withClient(laneUrl, async (client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${probe.role}`);
    await client.query(`SET LOCAL request.jwt.claim.role = '${probe.role}'`);
    if (probe.sub) await client.query(`SET LOCAL request.jwt.claim.sub = '${probe.sub}'`);
    const count = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${TABLE}`);
    await client.query('ROLLBACK');
    return count.rows[0].count;
  });
}

/** The plan one probe gets for a plain read with RLS active. */
async function probePlan(probe: Probe): Promise<string> {
  return withClient(laneUrl, async (client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${probe.role}`);
    await client.query(`SET LOCAL request.jwt.claim.role = '${probe.role}'`);
    if (probe.sub) await client.query(`SET LOCAL request.jwt.claim.sub = '${probe.sub}'`);
    const plan = await client.query(`EXPLAIN (COSTS OFF) SELECT account_id FROM ${TABLE}`);
    await client.query('ROLLBACK');
    return plan.rows.map((row) => Object.values(row)[0]).join('\n');
  });
}

/** One INSERT attempt by one probe, rolled back either way so the fixture
 *  rows stay the only rows. Resolves to 'ok' or the SQLSTATE. */
async function probeInsert(probe: Probe): Promise<string> {
  return withClient(laneUrl, async (client) => {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${probe.role}`);
    await client.query(`SET LOCAL request.jwt.claim.role = '${probe.role}'`);
    if (probe.sub) await client.query(`SET LOCAL request.jwt.claim.sub = '${probe.sub}'`);
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

/** The allowed and denied paths of the two policies, the same assertions
 *  before and after the rewrite. service_role reads and writes every row (it
 *  bypasses RLS on every Supabase image — the platform contract). An
 *  authenticated caller reads only its own account's rows and may write
 *  nothing (the users policy is SELECT-only and the service policy does not
 *  apply to it). anon, and authenticated without a subject, read and write
 *  nothing. */
async function expectUnchangedRowAccess(): Promise<void> {
  expect(await probeRowCount({ role: 'service_role' })).toBe('2');
  expect(await probeInsert({ role: 'service_role' })).toBe('ok');
  expect(await probeRowCount({ role: 'authenticated', sub: ACCOUNT_A })).toBe('1');
  expect(await probeRowCount({ role: 'authenticated', sub: ACCOUNT_B })).toBe('1');
  expect(await probeInsert({ role: 'authenticated', sub: ACCOUNT_A })).toBe('42501');
  expect(await probeRowCount({ role: 'authenticated' })).toBe('0');
  expect(await probeRowCount({ role: 'anon' })).toBe('0');
  expect(await probeInsert({ role: 'anon' })).toBe('42501');
}

async function dropLegacyFixture(admin: pg.Client): Promise<void> {
  await admin.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
}

/** The legacy state prod carries and the advisor flags: both policies bare. */
async function createLegacyFixture(admin: pg.Client, laneRoleName: string): Promise<void> {
  await dropLegacyFixture(admin);
  await admin.query(LEGACY_TABLE_SQL);
  await admin.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
  await admin.query(LEGACY_POLICIES_SQL);
  await admin.query(
    `INSERT INTO ${TABLE} (account_id, type) VALUES ('${ACCOUNT_A}', 'usage'), ('${ACCOUNT_B}', 'usage')`,
  );
  await admin.query(`GRANT ALL ON ${TABLE} TO authenticated, anon, service_role`);
  await admin.query(`ALTER TABLE ${TABLE} OWNER TO ${laneRoleName}`);
}

/** The table's policies keyed by name. */
async function readPolicies(): Promise<Record<string, Record<string, unknown>>> {
  return withClient(laneUrl, async (client) => {
    const rows = await client.query(
      `SELECT policyname, cmd, permissive, roles::text AS roles, qual::text, with_check::text
       FROM pg_policies WHERE schemaname = 'public' AND tablename = 'credit_ledger'`,
    );
    return Object.fromEntries(rows.rows.map((row) => [row.policyname as string, row]));
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
  });

  afterAll(async () => {
    await withClient(superuserUrl, async (admin) => {
      await dropLegacyFixture(admin);
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

    test('both legacy policies re-evaluate their auth calls per row (the advisor finding)', async () => {
      await withClient(laneUrl, async (client) => {
        const flagged = await client.query(LINTER_FINDS_BARE_AUTH_CALLS);
        expect(flagged.rows.map((row) => row.policyname).sort()).toEqual(
          [SERVICE_POLICY, USERS_POLICY].sort(),
        );
      });
      expect(await probePlan({ role: 'authenticated', sub: ACCOUNT_A })).not.toContain('InitPlan');
      expect(await probePlan({ role: 'anon' })).not.toContain('InitPlan');
    });

    test('row access before the rewrite: service-role writes, authenticated reads own rows only', async () => {
      await expectUnchangedRowAccess();
    });

    test('the migration wraps both calls and preserves both policy shapes', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);

        const flagged = await client.query(LINTER_FINDS_BARE_AUTH_CALLS);
        expect(flagged.rowCount).toBe(0);
      });

      const policies = await readPolicies();
      expect(Object.keys(policies).sort()).toEqual([SERVICE_POLICY, USERS_POLICY].sort());

      const service = policies[SERVICE_POLICY];
      expect(service.cmd).toBe('ALL');
      expect(service.permissive).toBe('PERMISSIVE');
      expect(service.roles).toBe('{service_role}');
      expect(String(service.qual)).toMatch(/select\s+(auth\.)?role\(\)/i);
      // Prod declares no WITH CHECK on this policy; the rewrite keeps it that way.
      expect(service.with_check).toBeNull();

      const users = policies[USERS_POLICY];
      expect(users.cmd).toBe('SELECT');
      expect(users.permissive).toBe('PERMISSIVE');
      expect(users.roles).toBe('{authenticated}');
      expect(String(users.qual)).toMatch(/select\s+(auth\.)?uid\(\)/i);
      expect(users.with_check).toBeNull();

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

    test('the governed read plan evaluates its call once per statement, not per row', async () => {
      // service_role bypasses RLS, so its plan carries no policy filter at
      // all; the init plan is observable on the governed authenticated path.
      expect(await probePlan({ role: 'authenticated', sub: ACCOUNT_A })).toContain('InitPlan');
    });

    test('row access after the rewrite: unchanged', async () => {
      await expectUnchangedRowAccess();
    });

    test('a second apply is idempotent: two policies, still the initplan form', async () => {
      await withClient(laneUrl, async (client) => {
        await client.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);
      });
      const policies = await readPolicies();
      expect(Object.keys(policies).sort()).toEqual([SERVICE_POLICY, USERS_POLICY].sort());
      expect(String(policies[SERVICE_POLICY].qual)).toMatch(/select\s+(auth\.)?role\(\)/i);
      expect(String(policies[USERS_POLICY].qual)).toMatch(/select\s+(auth\.)?uid\(\)/i);
      expect(await probePlan({ role: 'authenticated', sub: ACCOUNT_A })).toContain('InitPlan');
    });
  });

  test('the guard leaves an unexpected predicate untouched (the baseline wrapped form)', async () => {
    await withClient(superuserUrl, async (admin) => {
      await dropLegacyFixture(admin);
      await admin.query(LEGACY_TABLE_SQL);
      await admin.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
      await admin.query(`
        CREATE POLICY "${SERVICE_POLICY}" ON ${TABLE}
          TO service_role
          USING ((( SELECT auth.role() AS role) = 'service_role'::text));
        CREATE POLICY "${USERS_POLICY}" ON ${TABLE}
          FOR SELECT TO authenticated
          USING ((( SELECT auth.uid() AS uid) = account_id))
      `);
      await admin.query(`GRANT ALL ON ${TABLE} TO authenticated, anon, service_role`);
      await admin.query(`ALTER TABLE ${TABLE} OWNER TO ${laneRole}`);
    });

    await withClient(laneUrl, async (client) => {
      await client.query(`BEGIN;\n${migrationSql}\nCOMMIT;`);
    });

    const policies = await readPolicies();
    expect(String(policies[SERVICE_POLICY].qual)).toContain('SELECT auth.role() AS role');
    expect(String(policies[USERS_POLICY].qual)).toContain('SELECT auth.uid() AS uid');
  });

  test('never invents a policy on a table whose RLS runs with none', async () => {
    await withClient(superuserUrl, async (admin) => {
      await dropLegacyFixture(admin);
      await admin.query(`CREATE TABLE ${TABLE} (account_id uuid NOT NULL)`);
      await admin.query(`ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY`);
      await admin.query(`INSERT INTO ${TABLE} (account_id) VALUES ('${ACCOUNT_A}')`);
      await admin.query(`GRANT ALL ON ${TABLE} TO authenticated, anon, service_role`);
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
    // The seeded row exists, and RLS with no policy denies it to the governed
    // callers — the migration did not invent one to hand access back.
    // (service_role bypasses RLS and would see the row regardless.)
    expect(await probeRowCount({ role: 'anon' })).toBe('0');
    expect(await probeRowCount({ role: 'authenticated', sub: ACCOUNT_A })).toBe('0');
  });
});
