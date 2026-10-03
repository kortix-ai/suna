import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { resolve } from "node:path";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? test : test.skip;
const client = new pg.Client({ connectionString: url });
const migrationPath = resolve(
  import.meta.dir,
  "../migrations/20261003052133098_credit_accounts_single_select_policy.sql",
);
const owner = "00000000-0000-4000-a000-000000000001";
const other = "00000000-0000-4000-a000-000000000002";

beforeAll(async () => {
  if (url) await client.connect();
});
afterAll(async () => {
  if (url) await client.end();
});

async function apply() {
  await client.query(await Bun.file(migrationPath).text());
}

async function visible(role: string, subject: string) {
  await client.query("SAVEPOINT role_probe");
  try {
    await client.query("SET LOCAL ROLE authenticated");
    await client.query(
      "SELECT set_config('request.jwt.claim.role', $1, true), set_config('request.jwt.claim.sub', $2, true)",
      [role, subject],
    );
    return (
      await client.query(
        "SELECT account_id FROM public.credit_accounts ORDER BY account_id",
      )
    ).rows;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT role_probe");
  }
}

suite(
  "legacy policies have one SELECT path and preserve reads and service writes",
  async () => {
    await client.query("BEGIN");
    try {
      await client.query(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
      AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
    DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
    CREATE TABLE public.credit_accounts(account_id uuid PRIMARY KEY, balance numeric DEFAULT 0);
    ALTER TABLE public.credit_accounts ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.credit_accounts TO authenticated;
    CREATE POLICY "Service role manages credit accounts" ON public.credit_accounts USING ((SELECT auth.role()) = 'service_role') WITH CHECK ((SELECT auth.role()) = 'service_role' AND balance >= 0);
    CREATE POLICY "Users can view own credit account" ON public.credit_accounts FOR SELECT USING ((SELECT auth.uid()) = account_id);
    INSERT INTO public.credit_accounts(account_id) VALUES ('${owner}'), ('${other}');
  `);
      const before = await visible("authenticated", owner);
      expect(before).toEqual([{ account_id: owner }]);
      await client.query(
        'ALTER POLICY "Users can view own credit account" ON public.credit_accounts TO authenticated',
      );
      await client.query("SAVEPOINT invalid_shape");
      await expect(apply()).rejects.toThrow("Unexpected legacy");
      await client.query("ROLLBACK TO SAVEPOINT invalid_shape");
      await client.query(
        'ALTER POLICY "Users can view own credit account" ON public.credit_accounts TO PUBLIC',
      );
      await apply();
      const policies = (
        await client.query(
          "SELECT cmd FROM pg_policies WHERE schemaname='public' AND tablename='credit_accounts' AND permissive='PERMISSIVE' AND cmd IN ('ALL','SELECT')",
        )
      ).rows;
      expect(policies).toHaveLength(1);
      expect(await visible("authenticated", owner)).toEqual(before);
      expect(await visible("anon", "")).toEqual([]);
      expect(await visible("service_role", "")).toHaveLength(2);
      await client.query("SAVEPOINT role_probe");
      try {
        await client.query("SET LOCAL ROLE authenticated");
        await client.query(
          "SELECT set_config('request.jwt.claim.role', 'service_role', true)",
        );
        expect(
          (
            await client.query(
              "UPDATE public.credit_accounts SET balance=1 RETURNING account_id",
            )
          ).rows,
        ).toHaveLength(2);
        await client.query(
          "INSERT INTO public.credit_accounts(account_id) VALUES ('00000000-0000-4000-a000-000000000003')",
        );
        await client.query("SAVEPOINT rejected_write");
        await expect(
          client.query("UPDATE public.credit_accounts SET balance=-1"),
        ).rejects.toThrow("row-level security");
        await client.query("ROLLBACK TO SAVEPOINT rejected_write");
        await expect(
          client.query(
            "INSERT INTO public.credit_accounts(account_id, balance) VALUES ('00000000-0000-4000-a000-000000000004', -1)",
          ),
        ).rejects.toThrow("row-level security");
        await client.query("ROLLBACK TO SAVEPOINT rejected_write");
        expect(
          (
            await client.query(
              "DELETE FROM public.credit_accounts RETURNING account_id",
            )
          ).rows,
        ).toHaveLength(3);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT role_probe");
      }
      await client.query("SAVEPOINT role_probe");
      try {
        await client.query("SET LOCAL ROLE authenticated");
        await client.query(
          "SELECT set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claim.sub', $1, true)",
          [owner],
        );
        expect(
          (
            await client.query(
              "UPDATE public.credit_accounts SET balance=2 RETURNING account_id",
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await client.query(
              "DELETE FROM public.credit_accounts RETURNING account_id",
            )
          ).rows,
        ).toHaveLength(0);
        await expect(
          client.query(
            "INSERT INTO public.credit_accounts(account_id) VALUES ('00000000-0000-4000-a000-000000000003')",
          ),
        ).rejects.toThrow("row-level security");
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT role_probe");
      }
      const snapshot = (
        await client.query(
          "SELECT policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='credit_accounts' ORDER BY policyname",
        )
      ).rows;
      expect(
        (
          await client.query(
            "SELECT cmd, roles::text AS roles FROM pg_policies WHERE schemaname='public' AND tablename='credit_accounts' ORDER BY cmd",
          )
        ).rows,
      ).toEqual(
        ["DELETE", "INSERT", "SELECT", "UPDATE"].map((cmd) => ({
          cmd,
          roles: "{public}",
        })),
      );
      await apply();
      expect(
        (
          await client.query(
            "SELECT policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='credit_accounts' ORDER BY policyname",
          )
        ).rows,
      ).toEqual(snapshot);
      expect(await visible("authenticated", owner)).toEqual(before);
      await client.query("DROP TABLE public.credit_accounts");
      await client.query(
        `CREATE TABLE public.credit_accounts(account_id uuid); CREATE POLICY "Service role manages credit accounts" ON public.credit_accounts USING (false)`,
      );
      await apply();
      expect(
        (
          await client.query(
            "SELECT cmd, qual FROM pg_policies WHERE schemaname='public' AND tablename='credit_accounts'",
          )
        ).rows,
      ).toEqual([{ cmd: "ALL", qual: "false" }]);
      await client.query("DROP TABLE public.credit_accounts");
      await apply();
      expect(
        (
          await client.query(
            "SELECT to_regclass('public.credit_accounts') AS relation",
          )
        ).rows,
      ).toEqual([{ relation: null }]);
    } finally {
      await client.query("ROLLBACK");
    }
  },
);
