// Migration: drop_unused_billing_customers_email_gin_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `basejump.idx_billing_customers_email_gin` (GIN trigram on
// `lower(email) gin_trgm_ops`, 22 MB over ~194 k rows): the Supabase
// performance advisor flags it as unused (lint unused_index, level INFO,
// observed 2026-10-02). pg_stat_user_indexes on the prod project reads
// idx_scan = 0, idx_tup_read = 0, idx_tup_fetch = 0 (read 2026-10-03; the
// database's stats have never been reset, so zero really is zero). Every
// extra index costs an index write on each billing_customers INSERT/UPDATE,
// for nothing: Postgres plans by shape, never by index name.
//
// Nothing can consume a trigram email search on this table:
// - App code stopped reading and writing basejump.* entirely with
//   20260706120000000_retire_basejump (kortix.billing_customers absorbed the
//   mappings); a grep of the repo finds no read of basejump.billing_customers.
// - The table's one RLS policy ("Can only view own billing customer data.")
//   checks basejump.has_role_on_account(account_id) on SELECT — no email
//   search (read from the prod catalog).
// - The table's one trigger (ensure_billing_customer_email) only fills
//   NEW.email on write; it never queries the table by email.
// A trigram GIN index serves ILIKE / similarity reads only; none exist.
//
// `basejump.billing_customers` is the retired Suna/Supabase basejump schema's
// table. The Kortix baseline never creates it (only a `basejump.account_user`
// stub the legacy RLS still referenced), so a fresh/self-host database finds
// no index and `IF EXISTS` makes this a no-op there. It only exists on
// databases that predate the Kortix baseline (prod, and dev/staging if seeded
// from it).
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: drops a plain non-unique secondary GIN index. Nothing
// in the repo names it (a grep of idx_billing_customers_email_gin over the
// repo finds only this drop) and nothing depends on it: it backs no
// constraint (pg_constraint.conindid = 0, read from the prod catalog), a
// non-unique index serves no ON CONFLICT clause, and the table's RLS policy
// and trigger never search by email. A still-running older image plans the
// same queries — it only loses an option it never chose (idx_scan = 0), so
// the drop cannot fail or slow a query measurably.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists basejump.idx_billing_customers_email_gin`);
};

// Forward-only: the same concurrent flow rebuilds this index if a trigram
// email search on basejump.billing_customers ever returns.
export const down = false;
