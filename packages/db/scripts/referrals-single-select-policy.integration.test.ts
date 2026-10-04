import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { resolve } from "node:path";

const url = process.env.TEST_DATABASE_URL;
const suite = url ? test : test.skip;
const client = new pg.Client({ connectionString: url });
const migrationPath = resolve(
  import.meta.dir,
  "../migrations/20261004061020065_referrals_single_select_policy.sql",
);
const referrer = "00000000-0000-4000-a000-000000000001";
const referred = "00000000-0000-4000-a000-000000000002";
const other = "00000000-0000-4000-a000-000000000003";
const SERVICE_ROLE_QUAL = "auth.role() = 'service_role'::text";
const REFERRED_QUAL = "auth.uid() = referred_account_id";
const REFERRER_QUAL = "auth.uid() = referrer_id";

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
        "SELECT referred_account_id FROM public.referrals ORDER BY referred_account_id",
      )
    ).rows;
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT role_probe");
  }
}

/** The prod-observed legacy shape: one permissive ALL policy plus two permissive
 * SELECT policies, all TO PUBLIC, with the service ALL policy's WITH CHECK unset. */
async function createLegacyReferrals() {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
      AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
    DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; END $$;
    CREATE TABLE public.referrals(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      referrer_id uuid NOT NULL,
      referred_account_id uuid NOT NULL,
      referral_code text NOT NULL,
      credits_awarded numeric NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz DEFAULT now(),
      completed_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'
    );
    ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
    GRANT USAGE ON SCHEMA auth TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.referrals TO authenticated;
    CREATE POLICY "Service role manages referrals" ON public.referrals USING (${SERVICE_ROLE_QUAL});
    CREATE POLICY "Users can view own referrals as referred" ON public.referrals FOR SELECT USING (${REFERRED_QUAL});
    CREATE POLICY "Users can view own referrals as referrer" ON public.referrals FOR SELECT USING (${REFERRER_QUAL});
    INSERT INTO public.referrals(referrer_id, referred_account_id, referral_code)
      VALUES ('${referrer}', '${referred}', 'code-1'),
             ('${referrer}', '${other}', 'code-2'),
             ('${referred}', '${other}', 'code-3');
  `);
}

suite(
  "legacy referrals policies collapse to one permissive policy per action and preserve reads and service writes",
  async () => {
    await client.query("BEGIN");
    try {
      await createLegacyReferrals();

      // The legacy shape is exactly what the advisor flags: three permissive
      // policies cover SELECT for every role.
      expect(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='public' AND tablename='referrals' AND permissive='PERMISSIVE' AND (cmd='SELECT' OR cmd='ALL')",
          )
        ).rows,
      ).toEqual([{ n: 3 }]);

      // Reads before the migration: each side sees its own referrals.
      const referredView = await visible("authenticated", referred);
      expect(referredView).toHaveLength(2);
      expect(await visible("authenticated", other)).toHaveLength(2);
      expect(await visible("anon", "")).toEqual([]);
      expect(await visible("service_role", "")).toHaveLength(3);

      // A legacy table whose policies were already rewritten must not be
      // touched again: the migration is a no-op when the user policies are gone.
      await client.query(
        'DROP POLICY "Users can view own referrals as referred" ON public.referrals',
      );
      await client.query(
        'DROP POLICY "Users can view own referrals as referrer" ON public.referrals',
      );
      const onlyService = (
        await client.query(
          "SELECT policyname, cmd FROM pg_policies WHERE schemaname='public' AND tablename='referrals'",
        )
      ).rows;
      await apply();
      expect(
        (
          await client.query(
            "SELECT policyname, cmd FROM pg_policies WHERE schemaname='public' AND tablename='referrals'",
          )
        ).rows,
      ).toEqual(onlyService);
      await client.query("DROP TABLE public.referrals");

      // The real legacy shape.
      await createLegacyReferrals();

      // An unexpected policy shape fails closed instead of inventing access.
      await client.query(
        'ALTER POLICY "Users can view own referrals as referred" ON public.referrals TO authenticated',
      );
      await client.query("SAVEPOINT invalid_shape");
      await expect(apply()).rejects.toThrow("Unexpected legacy");
      await client.query("ROLLBACK TO SAVEPOINT invalid_shape");
      await client.query(
        'ALTER POLICY "Users can view own referrals as referred" ON public.referrals TO PUBLIC',
      );

      await apply();

      // One permissive policy per action, never more.
      expect(
        (
          await client.query(
            "SELECT cmd, roles::text AS roles FROM pg_policies WHERE schemaname='public' AND tablename='referrals' ORDER BY cmd",
          )
        ).rows,
      ).toEqual(
        ["DELETE", "INSERT", "SELECT", "UPDATE"].map((cmd) => ({
          cmd,
          roles: "{public}",
        })),
      );
      // The merged SELECT policy carries the three original predicates verbatim.
      expect(
        (
          await client.query(
            "SELECT qual FROM pg_policies WHERE schemaname='public' AND tablename='referrals' AND cmd='SELECT'",
          )
        ).rows,
      ).toEqual([
        {
          qual: `((${SERVICE_ROLE_QUAL}) OR (${REFERRED_QUAL}) OR (${REFERRER_QUAL}))`,
        },
      ]);

      // Reads unchanged.
      expect(await visible("authenticated", referred)).toEqual(referredView);
      expect(await visible("authenticated", other)).toHaveLength(2);
      expect(await visible("anon", "")).toEqual([]);
      expect(await visible("service_role", "")).toHaveLength(3);

      // Service writes unchanged: the split write paths carry the same
      // service-role predicate the ALL policy had.
      await client.query("SAVEPOINT role_probe");
      try {
        await client.query("SET LOCAL ROLE authenticated");
        await client.query(
          "SELECT set_config('request.jwt.claim.role', 'service_role', true)",
        );
        expect(
          (
            await client.query(
              "INSERT INTO public.referrals(referrer_id, referred_account_id, referral_code) VALUES ('" +
                referrer +
                "', '" +
                other +
                "', 'code-4') RETURNING id",
            )
          ).rows,
        ).toHaveLength(1);
        expect(
          (
            await client.query(
              "UPDATE public.referrals SET status='complete' RETURNING id",
            )
          ).rows,
        ).toHaveLength(4);
        expect(
          (
            await client.query(
              "DELETE FROM public.referrals WHERE referral_code='code-4' RETURNING id",
            )
          ).rows,
        ).toHaveLength(1);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT role_probe");
      }

      // User writes stay rejected.
      await client.query("SAVEPOINT role_probe");
      try {
        await client.query("SET LOCAL ROLE authenticated");
        await client.query(
          "SELECT set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claim.sub', $1, true)",
          [referrer],
        );
        await client.query("SAVEPOINT rejected_write");
        await expect(
          client.query(
            "INSERT INTO public.referrals(referrer_id, referred_account_id, referral_code) VALUES ('" +
              referrer +
              "', '" +
              other +
              "', 'code-5')",
          ),
        ).rejects.toThrow("row-level security");
        await client.query("ROLLBACK TO SAVEPOINT rejected_write");
        expect(
          (
            await client.query(
              "UPDATE public.referrals SET status='complete' RETURNING id",
            )
          ).rows,
        ).toHaveLength(0);
        expect(
          (
            await client.query(
              "DELETE FROM public.referrals RETURNING id",
            )
          ).rows,
        ).toHaveLength(0);
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT role_probe");
      }

      // A second apply is a no-op: the user policies are gone, so the guard
      // returns before touching anything.
      const snapshot = (
        await client.query(
          "SELECT policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='referrals' ORDER BY policyname",
        )
      ).rows;
      await apply();
      expect(
        (
          await client.query(
            "SELECT policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='referrals' ORDER BY policyname",
          )
        ).rows,
      ).toEqual(snapshot);

      // A fresh baseline has no table at all: the apply is a no-op.
      await client.query("DROP TABLE public.referrals");
      await apply();
      expect(
        (
          await client.query(
            "SELECT to_regclass('public.referrals') AS relation",
          )
        ).rows,
      ).toEqual([{ relation: null }]);
    } finally {
      await client.query("ROLLBACK");
    }
  },
);
