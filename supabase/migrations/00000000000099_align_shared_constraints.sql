-- ============================================================================
-- 00000000000099  align_shared_constraints
-- Reconcile CONSTRAINTS on pre-existing (shared) tables to the target schema.
-- Companion to 098 (which aligned tables/columns/enums). Drops 27 superseded
-- legacy constraints (e.g. the api_keys->sandboxes FK that blocks session sandboxes,
-- and stale credit_* checks/FKs) and adds 4 target constraints.
-- Constraint drops remove validation only — NO data is deleted. Idempotent.
-- New FK/CHECK added as NOT VALID (enforced on new rows; existing rows untouched).
-- ============================================================================

SET search_path = kortix, public;

-- ---- drop superseded legacy constraints (27) ----
ALTER TABLE kortix."credit_usage" DROP CONSTRAINT IF EXISTS "credit_usage_thread_id_fkey";
ALTER TABLE kortix."pool_sandboxes" DROP CONSTRAINT IF EXISTS "pool_sandboxes_resource_id_fkey";
ALTER TABLE kortix."credit_ledger" DROP CONSTRAINT IF EXISTS "unique_stripe_event";
ALTER TABLE kortix."credit_purchases" DROP CONSTRAINT IF EXISTS "credit_purchases_provider_check";
ALTER TABLE kortix."credit_purchases" DROP CONSTRAINT IF EXISTS "credit_purchases_revenuecat_transaction_id_key";
ALTER TABLE kortix."account_deletion_requests" DROP CONSTRAINT IF EXISTS "account_deletion_requests_account_id_fkey";
ALTER TABLE kortix."account_deletion_requests" DROP CONSTRAINT IF EXISTS "account_deletion_requests_user_id_fkey";
ALTER TABLE kortix."credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_account_id_fkey";
ALTER TABLE kortix."credit_usage" DROP CONSTRAINT IF EXISTS "credit_usage_usage_type_check";
ALTER TABLE kortix."credit_usage" DROP CONSTRAINT IF EXISTS "credit_usage_user_id_fkey";
ALTER TABLE kortix."credit_purchases" DROP CONSTRAINT IF EXISTS "credit_purchases_amount_dollars_check";
ALTER TABLE kortix."credit_purchases" DROP CONSTRAINT IF EXISTS "credit_purchases_amount_positive";
ALTER TABLE kortix."credit_purchases" DROP CONSTRAINT IF EXISTS "credit_purchases_status_check";
ALTER TABLE kortix."credit_purchases" DROP CONSTRAINT IF EXISTS "credit_purchases_stripe_payment_intent_id_key";
ALTER TABLE kortix."credit_purchases" DROP CONSTRAINT IF EXISTS "credit_purchases_user_id_fkey";
ALTER TABLE kortix."credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_type_check";
ALTER TABLE kortix."credit_accounts" DROP CONSTRAINT IF EXISTS "credit_accounts_account_id_fkey";
ALTER TABLE kortix."credit_accounts" DROP CONSTRAINT IF EXISTS "credit_accounts_payment_status_check";
ALTER TABLE kortix."credit_accounts" DROP CONSTRAINT IF EXISTS "credit_accounts_plan_type_check";
ALTER TABLE kortix."credit_accounts" DROP CONSTRAINT IF EXISTS "credit_accounts_provider_check";
ALTER TABLE kortix."credit_accounts" DROP CONSTRAINT IF EXISTS "credit_accounts_trial_status_check";
ALTER TABLE kortix."credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_created_by_fkey";
ALTER TABLE kortix."credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_triggered_by_user_id_fkey";
ALTER TABLE kortix."credit_ledger" DROP CONSTRAINT IF EXISTS "credit_ledger_user_id_fkey";
ALTER TABLE kortix."api_keys" DROP CONSTRAINT IF EXISTS "api_keys_sandbox_id_sandboxes_sandbox_id_fk";
ALTER TABLE kortix."credit_usage" DROP CONSTRAINT IF EXISTS "credit_usage_amount_dollars_check";
ALTER TABLE kortix."credit_usage" DROP CONSTRAINT IF EXISTS "credit_usage_message_id_fkey";

-- ---- add missing target constraints (4) ----
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='kortix_unique_stripe_event' AND conrelid='kortix."credit_ledger"'::regclass) THEN
    ALTER TABLE kortix."credit_ledger" ADD CONSTRAINT "kortix_unique_stripe_event" UNIQUE (stripe_event_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_members_account_id_accounts_account_id_fk' AND conrelid='kortix."account_members"'::regclass) THEN
    ALTER TABLE kortix."account_members" ADD CONSTRAINT "account_members_account_id_accounts_account_id_fk" FOREIGN KEY (account_id) REFERENCES kortix.accounts(account_id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='pool_sandboxes_resource_id_pool_resources_id_fk' AND conrelid='kortix."pool_sandboxes"'::regclass) THEN
    ALTER TABLE kortix."pool_sandboxes" ADD CONSTRAINT "pool_sandboxes_resource_id_pool_resources_id_fk" FOREIGN KEY (resource_id) REFERENCES kortix.pool_resources(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='kortix_credit_accounts_billing_model_check' AND conrelid='kortix."credit_accounts"'::regclass) THEN
    ALTER TABLE kortix."credit_accounts" ADD CONSTRAINT "kortix_credit_accounts_billing_model_check" CHECK ((billing_model = ANY (ARRAY['legacy'::text, 'per_seat'::text]))) NOT VALID;
  END IF;
END $$;

