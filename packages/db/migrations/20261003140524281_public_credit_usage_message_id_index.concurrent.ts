// Migration: public_credit_usage_message_id_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// This file exists ONLY because CREATE/DROP INDEX CONCURRENTLY (and a
// handful of other operations: REINDEX CONCURRENTLY, DETACH PARTITION
// CONCURRENTLY) cannot run inside a transaction -- and every plain .sql
// migration in this repo runs inside the single batch transaction
// node-pg-migrate wraps around `pnpm migrate` (singleTransaction: true,
// see packages/db/scripts/migrate.ts). `pgm.noTransaction()` is
// node-pg-migrate's own supported opt-out: when it hits a migration that
// called this, it COMMITs the outer transaction, runs THIS migration
// standalone (no transaction), then re-opens BEGIN for whatever runs after
// it in the same batch. See MIGRATIONS.md "Roll-forward safety".
//
// Rules for this file:
//   - ONE concurrent operation. Don't smuggle other DDL in here -- you lose
//     the all-or-nothing guarantee the moment you opt out of the transaction.
//   - Always use IF NOT EXISTS / IF EXISTS -- a CONCURRENTLY build can fail
//     partway through and leave an INVALID index; the migration must be safe
//     to re-run (check pg_index.indisvalid before retrying by hand if it does).
//   - lock_timeout MUST be generous here -- 180s below, never the 2-5s used by
//     a plain .sql migration. CREATE INDEX CONCURRENTLY does not just take a
//     brief lock at the end: before it can start, and again before it can
//     finish, it waits for EVERY transaction in the database that began before
//     it (it takes a ShareLock on each one's virtual transaction id), and
//     `lock_timeout` governs that wait. On a live system -- audit_events
//     writers on every request, multi-second session-turn transactions -- some
//     transaction outlives a 5-second budget almost every time, so the build is
//     cancelled with 55P03 and leaves an INVALID index behind, which then makes
//     a plain re-run fail with "already exists". The 2-5s house value exists to
//     stop DDL blocking prod; the one lock a CONCURRENTLY build holds
//     (ShareUpdateExclusive on the table) only excludes other DDL and VACUUM,
//     so a long wait here blocks no user and that rationale does not apply.
//     This is lint-enforced: a new .concurrent.ts file that sets lock_timeout
//     below 120s fails `pnpm --filter @kortix/db lint`.
//   - statement_timeout should be generous (index builds on large tables can
//     legitimately run long) -- 30min below.
//   - This is lint-enforced: packages/db/scripts/lint-migrations.ts requires
//     pgm.noTransaction() AND a CONCURRENTLY operation in every .concurrent.ts
//     file, or CI fails.
//   - DROPPING an index/constraint here (not just creating one) is ALSO
//     covered by the mixed-version guard, same as a plain .sql migration --
//     add `// mixed-version-safe: <justification>` above `up` if this drops
//     something old code might still read (see MIGRATIONS.md).
//
// What this indexes: the legacy `public.credit_usage` table (pre-baseline
// basejump-era schema, kept in place by 20260706120000000_retire_basejump).
// Its FK `credit_usage_message_id_fkey` (message_id -> messages.message_id,
// ON DELETE SET NULL) has no covering index, so every DELETE on `messages`
// must seq-scan `public.credit_usage` to null the references — the exact
// shape Supabase's `unindexed_foreign_keys` lint flags (KRTX-1123). The two
// sibling FKs are already covered (`idx_credit_usage_account_id` guards
// credit_usage_user_id_fkey, `idx_credit_usage_thread_id` guards
// credit_usage_thread_id_fkey); this FK is the only uncovered one. Fresh databases never create
// this table (the baseline only builds `kortix.credit_usage`, and
// drizzle/0000_bootstrap.sql does not build the legacy one), so `up` guards
// on the table's existence and does nothing on a fresh environment.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = async (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  //
  // The legacy table exists only on environments that predate the Kortix
  // baseline (prod, dev). A `DO $$ ... IF NOT EXISTS ... $$` guard cannot
  // wrap a CONCURRENTLY build (DO is itself a transaction), so ask the
  // catalog first and queue nothing on a fresh environment.
  const { rowCount } = await pgm.db.query(
    `select 1
       from pg_catalog.pg_class c
       join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = 'credit_usage' and c.relkind = 'r'`,
  );
  if ((rowCount ?? 0) === 0) {
    // eslint-disable-next-line no-console
    console.log(
      '[public_credit_usage_message_id_index] public.credit_usage absent (fresh environment) -- nothing to index',
    );
    return;
  }
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  // Mirrors the indexes the pre-baseline schema already keeps on this
  // table's other FK columns (idx_credit_usage_account_id,
  // idx_credit_usage_thread_id) and the covering index Supabase's
  // 0001_unindexed_foreign_keys lint looks for: its check requires an index
  // whose leading columns are the FK's columns. Read-only against prod
  // 2026-10-02 before this change: public.credit_usage holds 0 rows and
  // public.messages 56.9M, so the build is trivial but the FK delete path
  // stays a seq scan until this index exists.
  pgm.sql(`
    create index concurrently if not exists idx_credit_usage_message_id
      on public.credit_usage (message_id)
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
