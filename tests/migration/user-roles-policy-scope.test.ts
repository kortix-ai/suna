import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';

const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
const migration = new URL(
  '../../packages/db/migrations/20261003052236221_user_roles_service_policy_scope.sql',
  import.meta.url,
);
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL)
    throw new Error('TEST_DATABASE_URL must point to a disposable migrated database');
  await client.connect();
  await client.query('BEGIN');
});
afterAll(async () => {
  await client.query('ROLLBACK');
  await client.end();
});

async function applyMigration() {
  await client.query(await readFile(migration, 'utf8'));
}

async function visible(role: string, subject: string) {
  await client.query(`SET LOCAL ROLE ${role}`);
  await client.query(
    "SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claim.role', $2, true)",
    [subject, role],
  );
  try {
    return (
      await client.query('SELECT user_id::text FROM public.user_roles ORDER BY user_id')
    ).rows.map((row) => row.user_id);
  } finally {
    await client.query('RESET ROLE');
  }
}

describe('legacy user_roles service policy scope', () => {
  test('fresh databases without the legacy table remain valid', async () => {
    expect(
      (await client.query("SELECT to_regclass('public.user_roles') AS relation")).rows[0].relation,
    ).toBeNull();
    await applyMigration();
    expect(
      (await client.query("SELECT to_regclass('public.user_roles') AS relation")).rows[0].relation,
    ).toBeNull();
  });

  test('removes overlapping SELECT policies without changing access or writes', async () => {
    await client.query(`CREATE TABLE public.user_roles (user_id uuid PRIMARY KEY, role text NOT NULL);
      ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_roles TO anon, authenticated, service_role;
      CREATE POLICY "Service role can manage all roles" ON public.user_roles FOR ALL TO PUBLIC USING (auth.role() = 'service_role');
      CREATE POLICY "Users can view their own role" ON public.user_roles FOR SELECT TO PUBLIC USING (auth.uid() = user_id);
      INSERT INTO public.user_roles VALUES ('${owner}', 'user'), ('${other}', 'user');`);
    expect(await visible('authenticated', owner)).toEqual([owner]);
    expect(await visible('anon', '')).toEqual([]);
    await applyMigration();
    await applyMigration();
    const policies = (
      await client.query(
        "SELECT policyname, roles::text, cmd, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_roles' ORDER BY policyname",
      )
    ).rows;
    expect(policies).toEqual([
      {
        policyname: 'Service role can manage all roles',
        roles: '{service_role}',
        cmd: 'ALL',
        qual: "(auth.role() = 'service_role'::text)",
        with_check: null,
      },
      {
        policyname: 'Users can view their own role',
        roles: '{public}',
        cmd: 'SELECT',
        qual: '(auth.uid() = user_id)',
        with_check: null,
      },
    ]);
    expect(await visible('authenticated', owner)).toEqual([owner]);
    expect(await visible('authenticated', other)).toEqual([other]);
    expect(await visible('anon', '')).toEqual([]);
    await client.query('SET LOCAL ROLE authenticated');
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [owner]);
    expect(
      (await client.query("UPDATE public.user_roles SET role = 'admin' RETURNING user_id")).rows,
    ).toEqual([]);
    expect((await client.query('DELETE FROM public.user_roles RETURNING user_id')).rows).toEqual(
      [],
    );
    await client.query('SAVEPOINT denied_insert');
    await expect(
      client.query(
        "INSERT INTO public.user_roles VALUES ('44444444-4444-4444-8444-444444444444', 'user')",
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await client.query('ROLLBACK TO SAVEPOINT denied_insert');
    await client.query('RESET ROLE');
    expect(await visible('service_role', '')).toEqual([owner, other]);
    await client.query('SET LOCAL ROLE service_role');
    await client.query("SELECT set_config('request.jwt.claim.role', 'service_role', true)");
    await client.query(
      "INSERT INTO public.user_roles VALUES ('33333333-3333-4333-8333-333333333333', 'user')",
    );
    expect(
      (await client.query("UPDATE public.user_roles SET role = 'admin' RETURNING role")).rows,
    ).toHaveLength(3);
    expect(
      (await client.query('DELETE FROM public.user_roles RETURNING user_id')).rows,
    ).toHaveLength(3);
    await client.query('RESET ROLE');
    // Production service_role bypasses RLS; the advisor excludes such roles.
    // Earlier access checks deliberately used a non-bypass role to test policies.
    await client.query('ALTER ROLE service_role BYPASSRLS');
    expect(
      (
        await client.query(`SELECT r.rolname
      FROM pg_policy p JOIN pg_roles r
        ON p.polroles @> ARRAY[r.oid] OR p.polroles = ARRAY[0::oid]
      WHERE p.polrelid = 'public.user_roles'::regclass
        AND p.polpermissive AND p.polcmd IN ('r', '*')
        AND NOT r.rolbypassrls
      GROUP BY r.rolname HAVING count(*) > 1`)
      ).rows,
    ).toEqual([]);
  });

  test('a legacy table without the named policy is unchanged', async () => {
    await client.query('DROP POLICY "Service role can manage all roles" ON public.user_roles');
    await applyMigration();
    expect(
      (
        await client.query(
          "SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_roles'",
        )
      ).rows[0].count,
    ).toBe(1);
  });
});
