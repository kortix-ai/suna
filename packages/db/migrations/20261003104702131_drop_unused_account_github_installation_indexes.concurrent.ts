// Migration: drop_unused_account_github_installation_indexes  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops the two single-column indexes on kortix.account_github_installations
// that the Supabase performance advisor reports as `unused_index` and prod
// pg_stat_user_indexes confirms with idx_scan = 0 (cumulative counters, stats
// never reset, read-only 2026-10-03):
//
//   idx_account_github_installations_account   btree (account_id)    0 scans
//   idx_account_github_installations_owner     btree (owner_login)   0 scans
//
// Every read path filters account_id first, and the kept unique index
// idx_account_github_installations_account_installation (account_id,
// installation_id) serves every account_id prefix scan (89,664 scans). No SQL
// query filters owner_login: callers fetch the account's rows by account_id
// and filter owner_login in memory (accountGitHubInstallationsQuery and its
// callers in apps/api/src/projects/lib/git.ts). The two single-column indexes
// are pure write overhead on every insert and update.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader and
// no writer, and it only unlinks files (no heap rewrite). It cannot run in a
// transaction, hence this .concurrent.ts file (MIGRATIONS.md "Roll-forward
// safety"). lock_timeout is 180s: the statement waits for transactions that
// began before it (learnings 2026-08-19), and that wait blocks nobody.
//
// Two drops, one file: each is IF EXISTS and independent, so a re-run is safe
// and a partial application leaves the other drop pending, not broken.
//
// mixed-version-safe: no code or constraint references either index by name,
// and both have idx_scan = 0, so no running plan loses its chosen index; the
// account_id prefix of the kept unique index covers the same reads. Old and
// new code behave identically during the deploy window.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // IMPORTANT: separate pgm.sql() calls, NOT one multi-statement string.
  // Postgres's simple query protocol treats a single query string containing
  // multiple ;-separated statements as an IMPLICIT transaction block -- which
  // silently defeats pgm.noTransaction() (CONCURRENTLY still fails with
  // "cannot run inside a transaction block") even though noTransaction() IS
  // working correctly at the node-pg-migrate level. One statement per call.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    drop index concurrently if exists kortix.idx_account_github_installations_account
  `);
  pgm.sql(`
    drop index concurrently if exists kortix.idx_account_github_installations_owner
  `);
};

// Most CONCURRENTLY migrations are one-way in practice (see MIGRATIONS.md --
// "Down Migration" sections are policy-optional and this repo doesn't write
// them). Flip this to a real down function only if you have a tested reason to.
export const down = false;
