import { afterAll, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import postgres from 'postgres';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required');
const sql = postgres(process.env.TEST_DATABASE_SUPERUSER_URL ?? url, { max: 1 });
const migrationDirectory = resolve(import.meta.dir, '../migrations');
const names = Array.from(new Bun.Glob('*_consolidate_deletion_request_policies.sql').scanSync({ cwd: migrationDirectory }));
afterAll(() => sql.end());

test('removes SELECT overlap without changing user or service access', async () => {
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS auth;
    -- Roles are cluster-wide, not per database: a sibling suite (or a failed
    -- earlier run on this cluster) may have left the name behind.
    DROP ROLE IF EXISTS deletion_policy_reader;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
      $$ SELECT current_setting('request.jwt.claim.role', true) $$;
    CREATE ROLE deletion_policy_reader NOLOGIN;
    CREATE TABLE public.account_deletion_requests (id integer PRIMARY KEY, user_id uuid NOT NULL);
    ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA auth TO deletion_policy_reader;
    GRANT ALL ON public.account_deletion_requests TO deletion_policy_reader;
    INSERT INTO public.account_deletion_requests VALUES
      (1, '11111111-1111-4111-8111-111111111111'),
      (2, '22222222-2222-4222-8222-222222222222');
    CREATE POLICY "Service role can manage deletion requests" ON public.account_deletion_requests
      USING ((select auth.role()) = 'service_role');
    CREATE POLICY "Users can view their own deletion requests" ON public.account_deletion_requests
      FOR SELECT USING ((select auth.uid()) = user_id);
  `);
  async function access(role: string, uid: string) {
    return sql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE deletion_policy_reader');
      await tx`SELECT set_config('request.jwt.claim.role', ${role}, true), set_config('request.jwt.claim.sub', ${uid}, true)`;
      const rows = await tx`SELECT id FROM public.account_deletion_requests ORDER BY id`;
      const updated = await tx`UPDATE public.account_deletion_requests SET user_id = user_id RETURNING id`;
      const deleted = await tx`DELETE FROM public.account_deletion_requests WHERE id = 2 RETURNING id`;
      let inserted = false;
      try {
        await tx.savepoint(async insertion => {
          await insertion`INSERT INTO public.account_deletion_requests VALUES (3, '33333333-3333-4333-8333-333333333333')`;
          await insertion`DELETE FROM public.account_deletion_requests WHERE id = 3`;
        });
        inserted = true;
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== '42501') throw error;
      }
      if (deleted.length) await tx`INSERT INTO public.account_deletion_requests VALUES (2, '22222222-2222-4222-8222-222222222222')`;
      return { visible: rows.map(row => row.id), writable: updated.map(row => row.id).sort(), deleted: deleted.map(row => row.id), inserted };
    });
  }
  const inputs = [
    ['authenticated', '11111111-1111-4111-8111-111111111111'],
    ['authenticated', '22222222-2222-4222-8222-222222222222'],
    ['anon', ''], ['service_role', ''],
  ];
  // The role and table are dropped in a finally: an assertion failure must not
  // leak the cluster-wide role into every later suite on this cluster.
  try {
    const before = await Promise.all(inputs.map(([role, uid]) => access(role, uid)));
    expect(before).toEqual([
      { visible: [1], writable: [], deleted: [], inserted: false },
      { visible: [2], writable: [], deleted: [], inserted: false },
      { visible: [], writable: [], deleted: [], inserted: false },
      { visible: [1, 2], writable: [1, 2], deleted: [2], inserted: true },
    ]);
    if (names.length === 1) {
      const migration = await Bun.file(resolve(migrationDirectory, names[0])).text();
      await sql.begin(tx => tx.unsafe(migration));
      await sql.begin(tx => tx.unsafe(migration));
    }
    const selectPolicies = await sql`SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'account_deletion_requests'
        AND permissive = 'PERMISSIVE' AND cmd IN ('ALL', 'SELECT')`;
    expect(selectPolicies).toHaveLength(1);
    expect(await Promise.all(inputs.map(([role, uid]) => access(role, uid)))).toEqual(before);
  } finally {
    await sql.unsafe(`DROP TABLE public.account_deletion_requests;
      REVOKE USAGE ON SCHEMA auth FROM deletion_policy_reader;
      DROP ROLE deletion_policy_reader;`);
    if (names.length === 1) {
      const migration = await Bun.file(resolve(migrationDirectory, names[0])).text();
      await sql.begin(tx => tx.unsafe(migration));
    }
  }
});
