// Migration: apps_active_deployment_index  (NON-TRANSACTIONAL -- CONCURRENTLY escape hatch)
//
// Builds apps_active_deployment_idx (declared in kortix.ts) over the FK column
// behind `apps_active_deployment_fk` (active_deployment_id ->
// app_deployments.deployment_id, ON DELETE SET NULL). The Supabase advisor
// flags it as `unindexed_foreign_keys`. Without this index every deployment-row
// delete -- an app delete cascades into its deployments, and each deleted
// deployment triggers the SET NULL referential action on apps -- scans the
// whole kortix.apps table to find the pointer row. No other index on apps
// leads with active_deployment_id (apps_account_idx: account_id,
// apps_route_key_idx: route_key, apps_project_slug_live_unique: project_id,
// slug, partial).
//
// One btree column, the exact FK column, so the referential-action lookup and
// any future `where active_deployment_id = $1` read use it. Not partial: apps
// is a small user-facing table, so a NULL filter would save a negligible
// number of entries and narrow the index for no measured win.
//
// lock_timeout is 180s, not the 2-5s house value: CREATE INDEX CONCURRENTLY
// waits for every transaction that began before it, and lock_timeout governs
// that wait (see packages/db/MIGRATIONS.md). IF NOT EXISTS keeps a re-run
// safe; an INVALID leftover from a failed build must be dropped by hand first.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`
    create index concurrently if not exists apps_active_deployment_idx
      on kortix.apps (active_deployment_id)
  `);
};

// Purely additive index. No down migration (repo policy -- see MIGRATIONS.md).
export const down = false;
