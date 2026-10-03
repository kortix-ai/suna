// Migration: drop_kortix_yolo_api_keys_prefix_idx  (NON-TRANSACTIONAL -- DROP INDEX CONCURRENTLY)
//
// Drops `kortix_yolo.api_keys_prefix_idx` on `kortix_yolo.api_keys`: the
// Supabase performance advisor reports it as `unused_index` (INFO, EXTERNAL
// facing). The prod catalog is the evidence, read through the read-only
// Management API SQL endpoint on 2026-10-03:
//
//   - pg_stat_user_indexes: `idx_scan = 0` for every index on the table
//     (pkey, prefix, sha256) since stats began (`pg_stat_database.stats_reset`
//     is null) — no query has ever planned through this index.
//   - pg_depend: zero objects depend on it — no constraint, view or policy.
//   - The table is 53 rows / 64 kB heap, and its newest row is from 2026-04-17:
//     every read seq-scans it anyway, so the btree can never pay for the index
//     maintenance it adds to every write.
//
// `kortix_yolo` is the hosted YOLO platform's own schema (its api_keys,
// usage_logs, provider_keys, ... tables). This repo's migrations never create
// the schema and no repo code names the index or the table: the API resolves
// `kgw_…` through `kortix.gateway_api_keys`, `kyolo_…` through
// `kortix.yolo_member_tokens`, and PATs through `kortix.account_tokens`
// (apps/api/src/llm-gateway/hooks.ts). The YOLO platform runs its own deploys
// and never runs this migration chain. On a fresh self-host install or the CI
// shadow database the schema is absent, and `DROP INDEX IF EXISTS` skips with
// a notice ("schema ... does not exist, skipping") — verified against real
// PostgreSQL 15.19 and 16.2 servers, exit 0. The index only exists on
// databases seeded from prod.
//
// DROP INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE: it blocks no reader
// and no writer. It cannot run in a transaction, hence this .concurrent.ts
// file (MIGRATIONS.md "Roll-forward safety"). lock_timeout is 180s: the
// statement waits for transactions that began before it (learnings
// 2026-08-19), and that wait blocks nobody.
//
// mixed-version-safe: no old code can break. No repo code references the
// index (`git grep api_keys_prefix_idx` matches only this migration), the
// index is not unique (no ON CONFLICT can require it), pg_depend on prod
// holds zero dependencies, and the YOLO platform cannot reference an index
// by name — Postgres plans by shape, and no query has ever planned through
// this one (idx_scan = 0 since stats began).

export const shorthands = undefined;

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const up = (pgm) => {
  pgm.noTransaction();
  // One statement per pgm.sql() call: a multi-statement string runs as an
  // implicit transaction block and CONCURRENTLY then fails.
  pgm.sql(`set lock_timeout = '180s'`);
  pgm.sql(`set statement_timeout = '30min'`);
  pgm.sql(`drop index concurrently if exists kortix_yolo.api_keys_prefix_idx`);
};

// Forward-only: the advisor finding is the record that no query ever used it.
export const down = false;
