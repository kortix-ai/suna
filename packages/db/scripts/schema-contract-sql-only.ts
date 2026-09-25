/**
 * Objects in the `kortix` schema that SQL migrations manage and `kortix.ts`
 * does not declare. `scripts/schema-contract.ts` accepts exactly these, and
 * fails on anything else the database holds that kortix.ts does not declare.
 *
 * The list only shrinks. Never add an entry: declare a new object in
 * kortix.ts instead (for an index, move the generated CREATE INDEX into a
 * `.concurrent.ts` migration; see MIGRATIONS.md "Adding an index"). The gate
 * fails on an entry whose object is gone or declared, so a drop or a
 * declaration also deletes its entry. A unique index is never allowed here:
 * uniqueness is behaviour (an ON CONFLICT target, a de-duplication guard).
 */

export interface SqlOnlyList {
  /** Tables and views. Their columns and indexes are SQL-only too. */
  tables: Record<string, string>;
  /** `relation.column` on a relation kortix.ts declares. */
  columns: Record<string, string>;
  /** Non-unique indexes on a relation kortix.ts declares. */
  indexes: Record<string, string>;
}

const BASELINE =
  'Built by the 2026-06-21 baseline; kortix.ts never modelled it. Drop candidate once prod idx_scan shows no use.';
const COMPAT_VIEW =
  'RBAC compatibility view (20260819160100000). Raw SQL still reads it; kortix.ts declares the physical table. Drops with the compatibility layer (migrations-pending/README.md).';
const LEGACY_COLUMN = 'Baseline column that no kortix.ts reader uses. Drop candidate.';
const concurrently = (migration: string) =>
  `Built by ${migration}. Kept out of kortix.ts so drizzle-kit never emitted a plain CREATE INDEX for it.`;

export const SQL_ONLY: SqlOnlyList = {
  tables: {
    warm_pool_presence: 'Baseline table with no reader or writer. Drop candidate.',
    account_group_members: COMPAT_VIEW,
    iam_role_actions: COMPAT_VIEW,
    iam_roles: COMPAT_VIEW,
  },
  columns: {
    'account_deletion_requests.created_at': LEGACY_COLUMN,
    'account_deletion_requests.deleted_at': LEGACY_COLUMN,
    'account_deletion_requests.deletion_scheduled_for': LEGACY_COLUMN,
    'account_deletion_requests.updated_at': LEGACY_COLUMN,
    'chat_channel_bindings.agent_model': LEGACY_COLUMN,
    'credit_accounts.last_reconciled_at': LEGACY_COLUMN,
    'credit_accounts.needs_reconciliation': LEGACY_COLUMN,
    'credit_accounts.reconciliation_discrepancy': LEGACY_COLUMN,
    'credit_ledger.locked_at': LEGACY_COLUMN,
    'credit_ledger.message_id': LEGACY_COLUMN,
    'credit_ledger.team_member_email': LEGACY_COLUMN,
    'credit_ledger.thread_id': LEGACY_COLUMN,
    'credit_ledger.triggered_by_user_id': LEGACY_COLUMN,
    'credit_purchases.expires_at': LEGACY_COLUMN,
    'credit_purchases.last_reconciliation_attempt': LEGACY_COLUMN,
    'credit_purchases.reconciled_at': LEGACY_COLUMN,
    'credit_purchases.reconciliation_attempts': LEGACY_COLUMN,
    'credit_usage.message_id': LEGACY_COLUMN,
    'credit_usage.thread_id': LEGACY_COLUMN,
    'sandboxes.pooled_at': LEGACY_COLUMN,
    'session_sandboxes.pool_state': LEGACY_COLUMN,
  },
  indexes: {
    idx_account_tokens_session_id: concurrently('20260819015726000_account_tokens_session_id_index.concurrent.ts'),
    idx_credit_ledger_created_at: concurrently('20260807202731278_admin_analytics_ledger_time_index.concurrent.ts'),
    idx_project_secrets_project_strategy: concurrently('20260728132613912_secret_delivery_indexes.concurrent.ts'),
    idx_project_sessions_account_active: concurrently('20260727113441903_project_sessions_account_active_index.concurrent.ts'),
    idx_project_sessions_created_at: concurrently('20260807202731277_admin_analytics_time_indexes.concurrent.ts'),
    idx_project_sessions_project_updated: concurrently('20260916150159063_session_list_keyset_index.concurrent.ts'),
    idx_role_assignments_expires_at: concurrently('20260819015724479_rbac_canonical_model.sql'),
    idx_secret_handles_session: concurrently('20260728132613912_secret_delivery_indexes.concurrent.ts'),
    idx_session_sandboxes_deadline_active: concurrently('20260730000452600_sandbox_deadline_index.concurrent.ts'),
    idx_account_deletion_requests_account_id: BASELINE,
    idx_account_deletion_requests_scheduled: BASELINE,
    idx_account_deletion_requests_status: BASELINE,
    idx_account_deletion_requests_user_id: BASELINE,
    idx_credit_accounts_account_id: BASELINE,
    idx_credit_accounts_commitment: BASELINE,
    idx_credit_accounts_commitment_active: BASELINE,
    idx_credit_accounts_daily_balance: BASELINE,
    idx_credit_accounts_expiry: BASELINE,
    idx_credit_accounts_last_daily_refresh: BASELINE,
    idx_credit_accounts_last_grant: BASELINE,
    idx_credit_accounts_last_renewal_period: BASELINE,
    idx_credit_accounts_last_renewal_period_start: BASELINE,
    idx_credit_accounts_needs_reconciliation: BASELINE,
    idx_credit_accounts_next_grant: BASELINE,
    idx_credit_accounts_payment_status: BASELINE,
    idx_credit_accounts_plan_type: BASELINE,
    idx_credit_accounts_provider: BASELINE,
    idx_credit_accounts_revenuecat_cancel_at_period_end: BASELINE,
    idx_credit_accounts_revenuecat_customer: BASELINE,
    idx_credit_accounts_revenuecat_pending_change_date: BASELINE,
    idx_credit_accounts_revenuecat_product_id: BASELINE,
    idx_credit_accounts_scheduled_tier_change: BASELINE,
    idx_credit_accounts_stripe_subscription_id: BASELINE,
    idx_credit_accounts_subscription_status: BASELINE,
    idx_credit_accounts_tier: BASELINE,
    idx_credit_accounts_trial_status: BASELINE,
    idx_credit_accounts_yearly_renewal: BASELINE,
    idx_credit_ledger_account_created_debit: BASELINE,
    idx_credit_ledger_account_id: BASELINE,
    idx_credit_ledger_account_type_created_desc: BASELINE,
    idx_credit_ledger_created_by: BASELINE,
    idx_credit_ledger_expiry: BASELINE,
    idx_credit_ledger_idempotency: BASELINE,
    idx_credit_ledger_recent_ops: BASELINE,
    idx_credit_ledger_reference: BASELINE,
    idx_credit_ledger_stripe_event: BASELINE,
    idx_credit_ledger_triggered_by: BASELINE,
    idx_credit_ledger_type: BASELINE,
    idx_credit_purchases_account: BASELINE,
    idx_credit_purchases_account_id: BASELINE,
    idx_credit_purchases_created_at: BASELINE,
    idx_credit_purchases_provider: BASELINE,
    idx_credit_purchases_reconciled: BASELINE,
    idx_credit_purchases_revenuecat_transaction: BASELINE,
    idx_credit_purchases_status: BASELINE,
    idx_credit_purchases_stripe_payment_intent: BASELINE,
    idx_credit_usage_account_id: BASELINE,
    idx_credit_usage_created_at: BASELINE,
    idx_credit_usage_message_id: BASELINE,
    idx_credit_usage_thread_id: BASELINE,
    idx_sandboxes_pooled_fifo: BASELINE,
    idx_session_sandboxes_pool: BASELINE,
  },
};
