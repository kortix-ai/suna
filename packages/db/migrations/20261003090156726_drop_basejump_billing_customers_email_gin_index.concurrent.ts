// Migration: drop_basejump_billing_customers_email_gin_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `basejump.idx_billing_customers_email_gin` on `basejump.billing_customers`
// — a GIN trigram index on `lower(email) gin_trgm_ops` the Supabase performance
// advisor reports as `unused_index` (2026-10-03 prod: `idx_scan = 0`, 22 MB,
// while the table's other two indexes are both in use — pkey 410 scans,
// idx_billing_customers_account_id 16234 scans). The app stopped reading and
// writing basejump.* with 20260706120000000_retire_basejump (that migration's
// backfill moved the Stripe-customer mappings into kortix.billing_customers, the
// table the API reads today); the trigram email search this index served never
// ran. basejump is retired for the app but the schema itself is NOT dropped (see
// the retire_basejump header), so the index only kept costing 22 MB and write
// amplification on a dead table.
//
// The Kortix baseline never creates basejump.billing_customers (only the
// basejump.account_user stub — scripts/test-prereqs.sql), so a fresh self-host
// install or the CI shadow database finds no index and `IF EXISTS` makes this a
// no-op there.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader and
// no writer. It cannot run in a transaction, hence this .concurrent.ts file
// (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the statement
// waits for transactions that began before it (learnings 2026-08-19), and that
// wait blocks nobody.
//
// mixed-version-safe: the index is non-unique GIN, so no constraint, ON CONFLICT
// target or unique check can depend on it, and a git grep of the name over the
// repo finds nothing (verified on the prod database too: 0 constraint
// dependencies and 0 rewrite/view dependencies on the index). An old image still
// running cannot plan an email search it never ran.

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

// Forward-only: the retired table serves nothing; a future email search builds
// its own index against kortix.billing_customers.
export const down = false;
