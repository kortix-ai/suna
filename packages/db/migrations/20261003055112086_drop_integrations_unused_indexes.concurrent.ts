// Migration: drop_integrations_unused_indexes  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops the two kortix.integrations indexes the Supabase performance advisor
// reports as unused (lint unused_index, observed 2026-10-02):
//
//   idx_integrations_account          btree (account_id)           idx_scan = 0
//   idx_integrations_provider_account btree (provider_account_id)  idx_scan = 0
//
// pg_stat_user_indexes shows idx_scan = 0 and idx_tup_read = 0 for both, and
// pg_stat_database.stats_reset IS NULL — the counters were never reset, so the
// indexes have never served a scan. Each still costs an index write on every
// INSERT/UPDATE of the table. The table holds 169 rows (a seq scan is the
// cheaper plan at that size for anything that misses an index).
//
// No read path loses coverage:
//   - account_id filters are served by the leading column of the UNIQUE
//     idx_integrations_account_provider_account (account_id,
//     provider_account_id); Postgres plans account_id-only queries through it
//     (465 scans recorded), so the dropped single-column twin is redundant;
//   - provider_account_id has no reader at all: `git grep provider_account_id`
//     over the repo returns nothing.
//
// The Kortix baseline never creates kortix.integrations: no file in
// packages/db/migrations and no entry in packages/db/src/schema/kortix.ts
// names the table (it is a pre-baseline legacy table, same situation as
// public.agents). A fresh/self-host database finds no index, and `IF EXISTS`
// makes each statement a no-op there. It only exists on databases that
// predate the Kortix baseline (prod, and dev/staging if seeded from it).
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// Two statements, one file: each is IF EXISTS and independent, so a re-run
// after a partial failure is safe and no state needs all-or-nothing. They stay
// separate pgm.sql() calls: a multi-statement string is an implicit
// transaction and CONCURRENTLY would fail inside it.

export const shorthands = undefined;

// mixed-version-safe: read-path only. No application code names either index
// (a git grep of both names over the repo finds nothing) and no constraint,
// view, policy or ON CONFLICT clause depends on them (both are plain
// non-unique indexes; verified via pg_depend on the prod database — the only
// constraint on the table is integrations_pkey on integration_id). The
// account_id read keeps its coverage through the leading column of the unique
// idx_integrations_account_provider_account, so a still-running older image
// plans the same queries through it after the drop.
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix.idx_integrations_account`);
  pgm.sql(`drop index concurrently if exists kortix.idx_integrations_provider_account`);
};

// Forward-only. Re-creating never-scanned indexes would re-impose their write cost.
export const down = false;
