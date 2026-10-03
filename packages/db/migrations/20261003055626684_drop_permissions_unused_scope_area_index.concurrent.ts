// Migration: drop_permissions_unused_scope_area_index  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix.idx_permissions_scope_area` (btree (scope_type, area) on
// `kortix.permissions`): the Supabase performance advisor reports it as
// unused_index. pg_stat_user_indexes on prod shows idx_scan = idx_tup_read =
// idx_tup_fetch = 0 — the index has never served a scan — while the table's
// primary key (permissions_pkey on action) took 140 scans. Nothing in the repo
// filters the catalog by (scope_type, area): every read is a full-catalog
// select (apps/api/src/iam/catalog.ts `loadPermissionCatalog`, memoized with a
// 60s TTL; apps/api/src/__tests__/integration-iam-role-catalog-parity.test.ts
// reads whole columns). The table is a ~70-row / 104 kB action catalog — a seq
// scan is the right plan at this size — so the index only costs an index write
// per catalog row change and 16 kB of storage. The baseline and
// 20260819015724479_rbac_canonical_model.sql create it, so a fresh database
// builds then drops it; IF EXISTS keeps this safe to re-run.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: drops a plain non-unique index that backs no constraint
// (pg_index indisunique/indisprimary false and pg_constraint conindid empty on
// prod; pg_depend lists only the automatic index↔table entries). No code names
// it: a git grep of the name over the repo finds the creating migration and
// the schema declaration this PR removes, nothing else. Postgres never
// references an index by name in a query, so a still-running older image plans
// the same queries through seq scans, as it already does today.

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string is an implicit
  // transaction and CONCURRENTLY would fail inside it.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql('drop index concurrently if exists kortix.idx_permissions_scope_area');
};

// Forward-only: no query plans through this index; nothing rebuilds it.
export const down = false;
