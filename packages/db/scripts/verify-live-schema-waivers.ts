/**
 * Waives verify-live-schema.ts only: an entry means a live database may lack the object (schema-contract-sql-only.ts means kortix.ts does not declare it).
 *
 * Indexes and constraints the migrations build that a live database may lack
 * on purpose. `scripts/verify-live-schema.ts` reports each of these as waived
 * instead of failing. Everything else the migrations build must exist on the
 * live database with the same definition.
 *
 * Why this list exists: prod's baseline was faked (MIGRATIONS.md "baseline"),
 * so prod never received the indexes and constraints the baseline builds. A
 * read-only catalog diff of prod against a freshly migrated database on
 * 2026-09-25 found 56 missing index definitions and 10 missing constraints.
 * The 20260925023833525..20260925023837104 migrations build every one that a
 * prod query needs or that enforces a rule. The rest are listed here, each
 * with the evidence for not building it on prod.
 *
 * Evidence sources, all read-only: prod `pg_stat_statements` (reset
 * 2026-06-24) and EXPLAIN plans; `idx_scan` on dev and staging, which have
 * every one of these indexes and have never reset their statistics.
 *
 * The list only shrinks. Never add an entry to hide new drift: build the
 * object with a migration instead. The verifier fails on an entry whose object
 * the migrations no longer build, so dropping an index also deletes its entry.
 */

export interface LiveSchemaWaivers {
  /** Index name (as the migrations name it) -> reason it may be absent. */
  indexes: Record<string, string>;
  /** Constraint name -> reason its definition may differ or be absent. */
  constraints: Record<string, string>;
}

const UNUSED =
  'Faked-baseline gap on prod. No prod query filters on these columns (pg_stat_statements); ' +
  'dev and staging, which have the index, record at most a handful of scans. Building it on prod ' +
  'adds write cost to a hot table for no reader. Drop candidate everywhere.';
const TINY =
  'Faked-baseline gap on prod. The table holds under 500 rows on prod, so a seq scan costs less ' +
  'than the index lookup; the index serves no measurable query there.';
const COVERED_BY_ACCOUNT_ID =
  'Faked-baseline gap on prod. Every account-scoped ledger read is served by ' +
  'idx_credit_ledger_account_id (account_id, created_at DESC), which ' +
  '20260925023833525_credit_ledger_account_id_index builds on prod.';
const EQUIVALENT = (liveDef: string) =>
  `Prod has an index of this name with the definition ${liveDef}. A btree answers the same ` +
  'equality and ordered lookups with either definition, so rebuilding it gains nothing.';

export const LIVE_SCHEMA_WAIVERS: LiveSchemaWaivers = {
  indexes: {
    // credit_ledger (2.7M rows on prod)
    idx_credit_ledger_recent_ops: COVERED_BY_ACCOUNT_ID + ' Same leading keys; the extra columns never make a prod query index-only.',
    idx_credit_ledger_account_type_created_desc:
      COVERED_BY_ACCOUNT_ID + ' The type-filtered reads are per-account, so the (account_id, created_at) range is already small.',
    idx_credit_ledger_account_created_debit:
      'Faked-baseline gap on prod. Its predicate is `amount < 0`; the debit reads filter `amount_precise < $n`, ' +
      'so the planner cannot use it (0 scans on dev and staging).',
    idx_credit_ledger_stripe_event:
      'Duplicate of the unique index kortix_unique_stripe_event on the same column, which prod has.',
    idx_credit_ledger_expiry: UNUSED,
    idx_credit_ledger_reference: UNUSED,
    idx_credit_ledger_created_by: UNUSED,
    idx_credit_ledger_triggered_by: UNUSED,
    idx_credit_ledger_type: UNUSED,

    // credit_accounts (234k rows on prod, ~2.4M updates since the stats reset)
    idx_credit_accounts_tier:
      'Faked-baseline gap on prod. The only tier-filtered query asks for tier = \'free\', which is 99.7% of prod rows; ' +
      'the planner seq-scans with or without the index (EXPLAIN on staging).',
    idx_credit_accounts_yearly_renewal:
      'Faked-baseline gap on prod. Its predicate requires next_credit_grant IS NOT NULL; the yearly-renewal query also ' +
      'accepts NULL, so it is served by idx_credit_accounts_plan_type instead.',
    idx_credit_accounts_last_renewal_period:
      'Faked-baseline gap on prod. Leads with account_id; the reads that use it on dev and staging are ' +
      'account_id lookups that the primary key serves on prod.',
    idx_credit_accounts_commitment: UNUSED,
    idx_credit_accounts_commitment_active: UNUSED,
    idx_credit_accounts_daily_balance: UNUSED,
    idx_credit_accounts_expiry: UNUSED,
    idx_credit_accounts_last_daily_refresh: UNUSED,
    idx_credit_accounts_last_grant: UNUSED,
    idx_credit_accounts_last_renewal_period_start: UNUSED,
    idx_credit_accounts_needs_reconciliation: UNUSED,
    idx_credit_accounts_next_grant: UNUSED,
    idx_credit_accounts_payment_status: UNUSED,
    idx_credit_accounts_provider: UNUSED,
    idx_credit_accounts_revenuecat_cancel_at_period_end: UNUSED,
    idx_credit_accounts_revenuecat_customer: UNUSED,
    idx_credit_accounts_revenuecat_pending_change_date: UNUSED,
    idx_credit_accounts_revenuecat_product_id: UNUSED,
    idx_credit_accounts_scheduled_tier_change: UNUSED,
    idx_credit_accounts_stripe_subscription_id: UNUSED,
    idx_credit_accounts_subscription_status: UNUSED,

    // small tables
    idx_account_deletion_requests_account_id: TINY,
    idx_account_deletion_requests_scheduled: TINY,
    idx_account_deletion_requests_status: TINY,
    idx_account_deletion_requests_user_id: TINY,
    idx_credit_purchases_account: TINY,
    idx_credit_purchases_account_id: TINY,
    idx_credit_purchases_created_at: TINY,
    idx_credit_purchases_provider: TINY,
    idx_credit_purchases_reconciled: TINY,
    idx_credit_purchases_revenuecat_transaction: TINY,
    idx_credit_purchases_status: TINY,
    idx_credit_purchases_stripe_payment_intent: TINY,
    idx_credit_usage_account_id: TINY + ' The table is empty on prod.',
    idx_credit_usage_created_at: TINY + ' The table is empty on prod.',
    idx_credit_usage_message_id: TINY + ' The table is empty on prod.',
    idx_credit_usage_thread_id: TINY + ' The table is empty on prod.',
    idx_sandboxes_pooled_fifo: TINY + ' It serves the retired warm pool.',
    idx_project_trigger_runtime_owner_user:
      'Faked-baseline gap on prod. Its only reader is the identity-merge UPDATE (account-identity.ts), which runs ' +
      'on an account merge against a 7.4k-row table; 0 scans on staging.',

    // same name, equivalent definition on prod
    idx_account_tokens_project: EQUIVALENT('(project_id), without the `project_id IS NOT NULL` predicate'),
    idx_project_snapshot_builds_project_recent: EQUIVALENT('(project_id, started_at DESC NULLS LAST)'),
    idx_project_snapshot_builds_status: EQUIVALENT('(project_id, status, started_at DESC NULLS LAST)'),
    idx_sandbox_compute_sessions_account_time: EQUIVALENT('(account_id, started_at) ascending'),
  },
  constraints: {
    project_secrets_egress_policy_required:
      'Prod keeps the pre-20260806150353417 definition, which also admits consumer \'executor\'. That migration ' +
      'is in the prod ledger, but prod still has the enum label and the older CHECK. 0 prod rows use the label. ' +
      'Converging needs the enum rewrite that migration skipped on prod.',
  },
};
