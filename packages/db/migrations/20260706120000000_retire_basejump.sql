-- Retire the basejump account framework. App code no longer reads or writes
-- basejump.* (this deploy); this migration makes the database side match:
--
--   1. Credit-table RLS policies stop joining basejump.account_user and use
--      kortix.account_members instead (they were the last live objects that
--      referenced basejump from the kortix schema). kortix.credit_balance is
--      not touched — it was already dropped as discontinued (20260622073727110).
--   2. kortix.billing_customers absorbs any Stripe-customer mappings that
--      still lived only in basejump.billing_customers (for accounts that
--      exist in kortix) — the app's read-through sync used to do this lazily.
--   3. The signup trigger (auth.users → basejump.run_new_user_setup) is
--      dropped: new users are born kortix-native via the API's
--      bootstrapPersonalAccount, which has covered this path for a while.
--
-- The basejump schema itself is NOT dropped here — that is a follow-up,
-- separate deploy once this release has soaked (destructive-operation policy
-- in MIGRATIONS.md). Everything below is guarded so it also runs cleanly on
-- fresh self-host installs and CI databases where basejump is only a stub.

-- ── 1. Credit RLS → kortix.account_members ──────────────────────────────────

DROP POLICY IF EXISTS "Users can view own credit account"       ON kortix.credit_accounts;
DROP POLICY IF EXISTS "team_members_can_view_credit_account"    ON kortix.credit_accounts;
DROP POLICY IF EXISTS "team_owners_can_manage_credits"          ON kortix.credit_accounts;
DROP POLICY IF EXISTS "users can view credit accounts"          ON kortix.credit_accounts;
DROP POLICY IF EXISTS "Users can view own ledger"               ON kortix.credit_ledger;
DROP POLICY IF EXISTS "team_members_can_view_ledger"            ON kortix.credit_ledger;
DROP POLICY IF EXISTS "users can view credit ledger"            ON kortix.credit_ledger;
DROP POLICY IF EXISTS "Users can view their own credit usage"   ON kortix.credit_usage;
DROP POLICY IF EXISTS "users can view credit purchases"         ON kortix.credit_purchases;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'kortix' AND tablename = 'credit_accounts' AND policyname = 'credit_accounts_member_select') THEN
    CREATE POLICY credit_accounts_member_select ON kortix.credit_accounts FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM kortix.account_members am
                     WHERE am.account_id = credit_accounts.account_id
                       AND am.user_id = (SELECT auth.uid())));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'kortix' AND tablename = 'credit_accounts' AND policyname = 'credit_accounts_owner_manage') THEN
    CREATE POLICY credit_accounts_owner_manage ON kortix.credit_accounts TO authenticated
      USING (EXISTS (SELECT 1 FROM kortix.account_members am
                     WHERE am.account_id = credit_accounts.account_id
                       AND am.user_id = (SELECT auth.uid())
                       AND am.account_role = 'owner'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'kortix' AND tablename = 'credit_ledger' AND policyname = 'credit_ledger_member_select') THEN
    CREATE POLICY credit_ledger_member_select ON kortix.credit_ledger FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM kortix.account_members am
                     WHERE am.account_id = credit_ledger.account_id
                       AND am.user_id = (SELECT auth.uid())));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'kortix' AND tablename = 'credit_usage' AND policyname = 'credit_usage_member_select') THEN
    CREATE POLICY credit_usage_member_select ON kortix.credit_usage FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM kortix.account_members am
                     WHERE am.account_id = credit_usage.account_id
                       AND am.user_id = (SELECT auth.uid())));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'kortix' AND tablename = 'credit_purchases' AND policyname = 'credit_purchases_member_select') THEN
    CREATE POLICY credit_purchases_member_select ON kortix.credit_purchases FOR SELECT TO authenticated
      USING (EXISTS (SELECT 1 FROM kortix.account_members am
                     WHERE am.account_id = credit_purchases.account_id
                       AND am.user_id = (SELECT auth.uid())));
  END IF;
END $$;

-- ── 2. Backfill kortix.billing_customers from basejump ──────────────────────
-- Only rows whose account exists in kortix (dormant basejump-only users get a
-- fresh Stripe customer if they ever return — they have no active subs).

DO $$ BEGIN
  IF to_regclass('basejump.billing_customers') IS NOT NULL THEN
    INSERT INTO kortix.billing_customers (account_id, id, email, active, provider)
    SELECT b.account_id, b.id, b.email, COALESCE(b.active, true), COALESCE(b.provider, 'stripe')
    FROM basejump.billing_customers b
    JOIN kortix.accounts k ON k.account_id = b.account_id
    ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- ── 3. Drop the basejump signup trigger ─────────────────────────────────────
-- New auth users no longer get a basejump.accounts row; the API bootstraps
-- kortix personal accounts (account_id == user_id) on first touch.

DO $$ BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE '[retire-basejump] no privilege to drop auth.users trigger — drop it manually';
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'basejump') THEN
    DROP FUNCTION IF EXISTS basejump.run_new_user_setup();
  END IF;
END $$;
